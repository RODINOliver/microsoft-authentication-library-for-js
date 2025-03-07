/*
 * Copyright (c) Microsoft Corporation. All rights reserved.
 * Licensed under the MIT License.
 */

import { ApiId, Constants } from "../utils/Constants";
import {
    AuthenticationResult,
    CommonDeviceCodeRequest,
    AuthError,
    ResponseMode,
    OIDC_DEFAULT_SCOPES,
    CodeChallengeMethodValues,
    Constants as CommonConstants,
    ServerError,
    NativeRequest,
    NativeSignOutRequest,
    AccountInfo,
    INativeBrokerPlugin,
} from "@azure/msal-common";
import { Configuration } from "../config/Configuration";
import { ClientApplication } from "./ClientApplication";
import { IPublicClientApplication } from "./IPublicClientApplication";
import { DeviceCodeRequest } from "../request/DeviceCodeRequest";
import { AuthorizationUrlRequest } from "../request/AuthorizationUrlRequest";
import { AuthorizationCodeRequest } from "../request/AuthorizationCodeRequest";
import { InteractiveRequest } from "../request/InteractiveRequest";
import { NodeAuthError } from "../error/NodeAuthError";
import { LoopbackClient } from "../network/LoopbackClient";
import { SilentFlowRequest } from "../request/SilentFlowRequest";
import { SignOutRequest } from "../request/SignOutRequest";
import { ILoopbackClient } from "../network/ILoopbackClient";
import { DeviceCodeClient } from "./DeviceCodeClient";

/**
 * This class is to be used to acquire tokens for public client applications (desktop, mobile). Public client applications
 * are not trusted to safely store application secrets, and therefore can only request tokens in the name of an user.
 * @public
 */
export class PublicClientApplication
    extends ClientApplication
    implements IPublicClientApplication
{
    private nativeBrokerPlugin?: INativeBrokerPlugin;
    /**
     * Important attributes in the Configuration object for auth are:
     * - clientID: the application ID of your application. You can obtain one by registering your application with our Application registration portal.
     * - authority: the authority URL for your application.
     *
     * AAD authorities are of the form https://login.microsoftonline.com/\{Enter_the_Tenant_Info_Here\}.
     * - If your application supports Accounts in one organizational directory, replace "Enter_the_Tenant_Info_Here" value with the Tenant Id or Tenant name (for example, contoso.microsoft.com).
     * - If your application supports Accounts in any organizational directory, replace "Enter_the_Tenant_Info_Here" value with organizations.
     * - If your application supports Accounts in any organizational directory and personal Microsoft accounts, replace "Enter_the_Tenant_Info_Here" value with common.
     * - To restrict support to Personal Microsoft accounts only, replace "Enter_the_Tenant_Info_Here" value with consumers.
     *
     * Azure B2C authorities are of the form https://\{instance\}/\{tenant\}/\{policy\}. Each policy is considered
     * its own authority. You will have to set the all of the knownAuthorities at the time of the client application
     * construction.
     *
     * ADFS authorities are of the form https://\{instance\}/adfs.
     */
    constructor(configuration: Configuration) {
        super(configuration);
        if (this.config.broker.nativeBrokerPlugin) {
            if (this.config.broker.nativeBrokerPlugin.isBrokerAvailable) {
                this.nativeBrokerPlugin = this.config.broker.nativeBrokerPlugin;
                this.nativeBrokerPlugin.setLogger(
                    this.config.system.loggerOptions
                );
            } else {
                this.logger.warning(
                    "NativeBroker implementation was provided but the broker is unavailable."
                );
            }
        }
    }

    /**
     * Acquires a token from the authority using OAuth2.0 device code flow.
     * This flow is designed for devices that do not have access to a browser or have input constraints.
     * The authorization server issues a DeviceCode object with a verification code, an end-user code,
     * and the end-user verification URI. The DeviceCode object is provided through a callback, and the end-user should be
     * instructed to use another device to navigate to the verification URI to input credentials.
     * Since the client cannot receive incoming requests, it polls the authorization server repeatedly
     * until the end-user completes input of credentials.
     */
    public async acquireTokenByDeviceCode(
        request: DeviceCodeRequest
    ): Promise<AuthenticationResult | null> {
        this.logger.info(
            "acquireTokenByDeviceCode called",
            request.correlationId
        );
        const validRequest: CommonDeviceCodeRequest = Object.assign(
            request,
            await this.initializeBaseRequest(request)
        );
        const serverTelemetryManager = this.initializeServerTelemetryManager(
            ApiId.acquireTokenByDeviceCode,
            validRequest.correlationId
        );
        try {
            const deviceCodeConfig = await this.buildOauthClientConfiguration(
                validRequest.authority,
                validRequest.correlationId,
                serverTelemetryManager,
                undefined,
                request.azureCloudOptions
            );
            const deviceCodeClient = new DeviceCodeClient(deviceCodeConfig);
            this.logger.verbose(
                "Device code client created",
                validRequest.correlationId
            );
            return deviceCodeClient.acquireToken(validRequest);
        } catch (e) {
            if (e instanceof AuthError) {
                e.setCorrelationId(validRequest.correlationId);
            }
            serverTelemetryManager.cacheFailedRequest(e as AuthError);
            throw e;
        }
    }

    /**
     * Acquires a token interactively via the browser by requesting an authorization code then exchanging it for a token.
     */
    async acquireTokenInteractive(
        request: InteractiveRequest
    ): Promise<AuthenticationResult> {
        const correlationId =
            request.correlationId || this.cryptoProvider.createNewGuid();
        this.logger.trace("acquireTokenInteractive called", correlationId);
        const {
            openBrowser,
            successTemplate,
            errorTemplate,
            windowHandle,
            loopbackClient: customLoopbackClient,
            ...remainingProperties
        } = request;

        if (this.nativeBrokerPlugin) {
            const brokerRequest: NativeRequest = {
                ...remainingProperties,
                clientId: this.config.auth.clientId,
                scopes: request.scopes || OIDC_DEFAULT_SCOPES,
                redirectUri: `${Constants.HTTP_PROTOCOL}${Constants.LOCALHOST}`,
                authority: request.authority || this.config.auth.authority,
                correlationId: correlationId,
                extraParameters: {
                    ...remainingProperties.extraQueryParameters,
                    ...remainingProperties.tokenQueryParameters,
                },
                accountId: remainingProperties.account?.nativeAccountId,
            };
            return this.nativeBrokerPlugin.acquireTokenInteractive(
                brokerRequest,
                windowHandle
            );
        }

        const { verifier, challenge } =
            await this.cryptoProvider.generatePkceCodes();

        const loopbackClient: ILoopbackClient =
            customLoopbackClient || new LoopbackClient();

        const authCodeListener = loopbackClient.listenForAuthCode(
            successTemplate,
            errorTemplate
        );
        const redirectUri = loopbackClient.getRedirectUri();

        const validRequest: AuthorizationUrlRequest = {
            ...remainingProperties,
            correlationId: correlationId,
            scopes: request.scopes || OIDC_DEFAULT_SCOPES,
            redirectUri: redirectUri,
            responseMode: ResponseMode.QUERY,
            codeChallenge: challenge,
            codeChallengeMethod: CodeChallengeMethodValues.S256,
        };

        const authCodeUrl = await this.getAuthCodeUrl(validRequest);
        await openBrowser(authCodeUrl);
        const authCodeResponse = await authCodeListener.finally(() => {
            loopbackClient.closeServer();
        });

        if (authCodeResponse.error) {
            throw new ServerError(
                authCodeResponse.error,
                authCodeResponse.error_description,
                authCodeResponse.suberror
            );
        } else if (!authCodeResponse.code) {
            throw NodeAuthError.createNoAuthCodeInResponseError();
        }

        const clientInfo = authCodeResponse.client_info;
        const tokenRequest: AuthorizationCodeRequest = {
            code: authCodeResponse.code,
            codeVerifier: verifier,
            clientInfo: clientInfo || CommonConstants.EMPTY_STRING,
            ...validRequest,
        };
        return this.acquireTokenByCode(tokenRequest);
    }

    /**
     * Returns a token retrieved either from the cache or by exchanging the refresh token for a fresh access token. If brokering is enabled the token request will be serviced by the broker.
     * @param request
     * @returns
     */
    async acquireTokenSilent(
        request: SilentFlowRequest
    ): Promise<AuthenticationResult> {
        const correlationId =
            request.correlationId || this.cryptoProvider.createNewGuid();
        this.logger.trace("acquireTokenSilent called", correlationId);

        if (this.nativeBrokerPlugin) {
            const brokerRequest: NativeRequest = {
                ...request,
                clientId: this.config.auth.clientId,
                scopes: request.scopes || OIDC_DEFAULT_SCOPES,
                redirectUri: `${Constants.HTTP_PROTOCOL}${Constants.LOCALHOST}`,
                authority: request.authority || this.config.auth.authority,
                correlationId: correlationId,
                extraParameters: request.tokenQueryParameters,
                accountId: request.account.nativeAccountId,
                forceRefresh: request.forceRefresh || false,
            };
            return this.nativeBrokerPlugin.acquireTokenSilent(brokerRequest);
        }

        return super.acquireTokenSilent(request);
    }

    /**
     * Removes cache artifacts associated with the given account
     * @param request
     * @returns
     */
    async signOut(request: SignOutRequest): Promise<void> {
        if (this.nativeBrokerPlugin && request.account.nativeAccountId) {
            const signoutRequest: NativeSignOutRequest = {
                clientId: this.config.auth.clientId,
                accountId: request.account.nativeAccountId,
                correlationId:
                    request.correlationId ||
                    this.cryptoProvider.createNewGuid(),
            };
            await this.nativeBrokerPlugin.signOut(signoutRequest);
        }

        await this.getTokenCache().removeAccount(request.account);
    }

    /**
     * Returns all cached accounts for this application. If brokering is enabled this request will be serviced by the broker.
     * @returns
     */
    async getAllAccounts(): Promise<AccountInfo[]> {
        if (this.nativeBrokerPlugin) {
            const correlationId = this.cryptoProvider.createNewGuid();
            return this.nativeBrokerPlugin.getAllAccounts(
                this.config.auth.clientId,
                correlationId
            );
        }

        return this.getTokenCache().getAllAccounts();
    }
}
