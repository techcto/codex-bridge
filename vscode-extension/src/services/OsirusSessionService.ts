import * as vscode from 'vscode';
import type {
  OsirusActiveOrgResponse,
  OsirusDeviceAuthPollResponse,
  OsirusDeviceAuthStartResponse,
  OsirusMobileRefreshResponse,
  OsirusMobileSignInResponse,
  OsirusOrgMembership,
} from '../types';

const OSIRUS_ACCESS_TOKEN_SECRET_KEY = 'codexBridge.osirus.accessToken';
const OSIRUS_REFRESH_TOKEN_SECRET_KEY = 'codexBridge.osirus.refreshToken';
const OSIRUS_SELECTED_MODEL_SECRET_KEY = 'codexBridge.osirus.selectedModel';
const OSIRUS_EMAIL_SECRET_KEY = 'codexBridge.osirus.email';
const OSIRUS_PASSWORD_SECRET_KEY = 'codexBridge.osirus.password';
const OSIRUS_ACTIVE_ORG_ID_STATE_KEY = 'codexBridge.osirus.activeOrgId';
const OSIRUS_ACTIVE_ORG_NAME_STATE_KEY = 'codexBridge.osirus.activeOrgName';

export type OsirusSessionServiceDeps = {
  context: vscode.ExtensionContext;
  outputChannel?: vscode.OutputChannel;
  getAccountApiBaseUrl: () => string;
  getErrorMessage: (error: unknown) => string;
  requestExternalJson: <T>(
    method: string,
    url: string,
    body?: BodyInit | unknown,
    headers?: Record<string, string>
  ) => Promise<T>;
  refreshSidebar: () => void;
  pushChatPanelState: () => Promise<void>;
  setProviderApiKey: (value: string) => Promise<void>;
  clearOpenChatState: () => Promise<void>;
};

export class OsirusSessionService {
  private readonly context: vscode.ExtensionContext;
  private readonly outputChannel?: vscode.OutputChannel;
  private readonly getAccountApiBaseUrl: () => string;
  private readonly getErrorMessage: (error: unknown) => string;
  private readonly requestExternalJson: OsirusSessionServiceDeps['requestExternalJson'];
  private readonly refreshSidebar: () => void;
  private readonly pushChatPanelState: () => Promise<void>;
  private readonly setProviderApiKey: (value: string) => Promise<void>;
  private readonly clearOpenChatState: () => Promise<void>;

  public constructor(deps: OsirusSessionServiceDeps) {
    this.context = deps.context;
    this.outputChannel = deps.outputChannel;
    this.getAccountApiBaseUrl = deps.getAccountApiBaseUrl;
    this.getErrorMessage = deps.getErrorMessage;
    this.requestExternalJson = deps.requestExternalJson;
    this.refreshSidebar = deps.refreshSidebar;
    this.pushChatPanelState = deps.pushChatPanelState;
    this.setProviderApiKey = deps.setProviderApiKey;
    this.clearOpenChatState = deps.clearOpenChatState;
  }

  public async loginWithBrowser(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codexBridge');
    const baseUrl = this.getAccountApiBaseUrl();
    const start = await this.requestExternalJson<OsirusDeviceAuthStartResponse>(
      'POST',
      `${baseUrl}/auth/device/start`,
      {}
    );

    const deviceCode = String(start.device_code || '').trim();
    const verificationUrl = String(start.verification_uri_complete || start.verification_uri || '').trim();
    const intervalMs = Math.max(2, Number(start.interval || 2)) * 1000;
    const expiresAt = Date.now() + (Math.max(60, Number(start.expires_in || 300)) * 1000);

    if (!deviceCode || !verificationUrl) {
      throw new Error('Osirus device login did not return a browser verification URL.');
    }

    await vscode.env.openExternal(vscode.Uri.parse(verificationUrl));

    const poll = async (): Promise<OsirusDeviceAuthPollResponse> => {
      while (Date.now() < expiresAt) {
        const result = await this.requestExternalJson<OsirusDeviceAuthPollResponse>(
          'GET',
          `${baseUrl}/auth/device/poll?device_code=${encodeURIComponent(deviceCode)}`
        );
        const status = String(result.status || 'pending').trim().toLowerCase();
        if (status === 'approved') {
          return result;
        }
        if (status === 'expired' || status === 'consumed') {
          throw new Error(`Osirus device login ${status}. Start login again.`);
        }
        await this.delay(intervalMs);
      }
      throw new Error('Timed out waiting for Osirus browser login to finish.');
    };

    const payload = await vscode.window.withProgress<OsirusDeviceAuthPollResponse>(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'Waiting for Osirus sign-in in your browser...',
        cancellable: true,
      },
      async (_progress, token) => {
        token.onCancellationRequested(() => {
          throw new Error('Osirus browser sign-in was canceled.');
        });
        return poll();
      }
    );

    const accessToken = String(payload.access_token || '').trim();
    const refreshToken = String(payload.refresh_token || '').trim();
    if (!accessToken || !refreshToken) {
      throw new Error('Osirus browser sign-in did not return usable tokens.');
    }

    await this.clearCredentials();
    await this.setAuthTokens({ accessToken, refreshToken });
    const resolvedOrg = await this.ensureActiveOrgSelection({
      promptUser: false,
      tokenOverride: accessToken,
      preferredOrgId: String(payload.active_org_id || '').trim() || null,
    });
    await config.update('runtimeProvider', 'osirus', vscode.ConfigurationTarget.Global);
    await config.update('authMode', 'none', vscode.ConfigurationTarget.Global);
    await this.setProviderApiKey('');

    this.outputChannel?.appendLine(`[bridge] signed in to Osirus.AI via browser device flow (${baseUrl}/auth/device/start)`);
    this.outputChannel?.appendLine(`[bridge] active Osirus org: ${resolvedOrg.orgName} (${resolvedOrg.orgId})`);
    this.refreshSidebar();
    await this.pushChatPanelState();
    void vscode.window.showInformationMessage(`Signed in to Osirus.AI${resolvedOrg.orgName ? ` (${resolvedOrg.orgName})` : ''}. You can keep working in VS Code.`);
  }

  public async loginWithPassword(): Promise<void> {
    const config = vscode.workspace.getConfiguration('codexBridge');
    const email = await vscode.window.showInputBox({
      title: 'Login with Osirus.AI',
      prompt: 'Enter your Osirus account email.',
      ignoreFocusOut: true,
    });

    if (email === undefined) {
      return;
    }

    const password = await vscode.window.showInputBox({
      title: 'Osirus Password',
      prompt: 'Enter your Osirus account password.',
      password: true,
      ignoreFocusOut: true,
    });

    if (password === undefined) {
      return;
    }

    if (email.trim() === '' || password.trim() === '') {
      void vscode.window.showErrorMessage('Enter both your Osirus email and password.');
      return;
    }

    const baseUrl = this.getAccountApiBaseUrl();
    const payload = await this.requestExternalJson<OsirusMobileSignInResponse>(
      'POST',
      `${baseUrl}/auth/mobile/signin`,
      {
        email: email.trim(),
        password,
        captcha: null,
      }
    );

    const accessToken = String(payload.access_token || '').trim();
    const refreshToken = String(payload.refresh_token || '').trim();
    if (!accessToken || !refreshToken) {
      throw new Error('Osirus sign-in did not return access and refresh tokens.');
    }

    await this.setCredentials({ email: email.trim(), password });
    await this.setAuthTokens({ accessToken, refreshToken });
    const resolvedOrg = await this.ensureActiveOrgSelection({
      promptUser: true,
      tokenOverride: accessToken,
      preferredOrgId: String(payload.active_org_id || '').trim() || null,
    });
    await config.update('runtimeProvider', 'osirus', vscode.ConfigurationTarget.Global);
    await config.update('authMode', 'none', vscode.ConfigurationTarget.Global);
    await this.setProviderApiKey('');
    await this.clearOpenChatState();

    this.outputChannel?.appendLine(`[bridge] signed in to Osirus.AI via ${baseUrl}/auth/mobile/signin`);
    this.outputChannel?.appendLine(`[bridge] active Osirus org: ${resolvedOrg.orgName} (${resolvedOrg.orgId})`);
    this.refreshSidebar();
    await this.pushChatPanelState();
    void vscode.window.showInformationMessage(`Signed in to Osirus.AI for this extension${resolvedOrg.orgName ? ` (${resolvedOrg.orgName})` : ''}.`);
  }

  public async logout(): Promise<void> {
    await this.clearAuthTokens();
    await this.clearCredentials();
    await this.clearStoredActiveOrg();
    await this.clearOpenChatState();
    await this.pushChatPanelState();
    this.refreshSidebar();
    void vscode.window.showInformationMessage('Signed out from Osirus.AI in this extension.');
  }

  public async hasAccountSession(): Promise<boolean> {
    return (await this.getAccessToken()).trim() !== '';
  }

  public async getSavedSelectedModelId(): Promise<string> {
    return (await this.context.secrets.get(OSIRUS_SELECTED_MODEL_SECRET_KEY)) || '';
  }

  public async setSavedSelectedModelId(value: string): Promise<void> {
    const trimmed = value.trim();
    if (trimmed === '') {
      await this.context.secrets.delete(OSIRUS_SELECTED_MODEL_SECRET_KEY);
    } else {
      await this.context.secrets.store(OSIRUS_SELECTED_MODEL_SECRET_KEY, trimmed);
    }
  }

  public async getStoredActiveOrgId(): Promise<string> {
    return String(this.context.globalState.get<string>(OSIRUS_ACTIVE_ORG_ID_STATE_KEY) || '').trim();
  }

  public async getStoredActiveOrgName(): Promise<string> {
    return String(this.context.globalState.get<string>(OSIRUS_ACTIVE_ORG_NAME_STATE_KEY) || '').trim();
  }

  public async clearStoredActiveOrg(): Promise<void> {
    await this.context.globalState.update(OSIRUS_ACTIVE_ORG_ID_STATE_KEY, undefined);
    await this.context.globalState.update(OSIRUS_ACTIVE_ORG_NAME_STATE_KEY, undefined);
  }

  public async ensureActiveOrgSelection(options?: {
    promptUser?: boolean;
    tokenOverride?: string;
    preferredOrgId?: string | null;
  }): Promise<{ orgId: string; orgName: string }> {
    const token = String(options?.tokenOverride || '').trim() || await this.getValidAccessToken();
    const memberships = await this.fetchOrgMemberships(token);
    if (!memberships.length) {
      await this.clearStoredActiveOrg();
      throw new Error('Your Osirus account does not have any active organizations yet.');
    }

    const serverActiveOrgId = await this.getActiveOrgId(token);
    const storedOrgId = await this.getStoredActiveOrgId();
    const preferredOrgId = String(options?.preferredOrgId || '').trim();

    let selectedMembership: OsirusOrgMembership | undefined;
    if (memberships.length === 1) {
      selectedMembership = memberships[0];
    } else if (options?.promptUser) {
      const currentOrgId = preferredOrgId || storedOrgId || serverActiveOrgId;
      const picked = await vscode.window.showQuickPick(
        memberships.map((membership) => ({
          label: this.getOrgLabel(membership),
          description: membership.role ? `Role: ${membership.role}` : undefined,
          detail: membership.orgId === currentOrgId ? 'Current active org' : membership.orgId,
          membership,
        })),
        {
          title: 'Choose Osirus Organization',
          ignoreFocusOut: true,
          placeHolder: 'Select the Osirus organization this extension should use.',
        }
      );
      if (!picked) {
        throw new Error('Osirus organization selection was canceled.');
      }
      selectedMembership = picked.membership;
    } else {
      selectedMembership =
        memberships.find((membership) => membership.orgId === preferredOrgId) ||
        memberships.find((membership) => membership.orgId === storedOrgId) ||
        memberships.find((membership) => membership.orgId === serverActiveOrgId) ||
        memberships[0];
    }

    if (!selectedMembership) {
      throw new Error('Unable to resolve an Osirus organization for this session.');
    }

    const selectedOrgId = selectedMembership.orgId;
    if (selectedOrgId && selectedOrgId !== serverActiveOrgId) {
      await this.setActiveOrg(token, selectedOrgId);
      this.outputChannel?.appendLine(`[bridge] set active Osirus org to ${selectedOrgId}`);
    }

    const selectedOrgName = this.getOrgLabel(selectedMembership);
    if (selectedOrgId !== storedOrgId) {
      await this.clearOpenChatState();
    }
    await this.setStoredActiveOrg(selectedOrgId, selectedOrgName);
    this.refreshSidebar();
    return { orgId: selectedOrgId, orgName: selectedOrgName };
  }

  public async getValidAccessToken(): Promise<string> {
    const accessToken = (await this.getAccessToken()).trim();
    if (accessToken === '') {
      throw new Error('No Osirus access token is available. Sign in first.');
    }

    try {
      await this.requestExternalJson(
        'GET',
        `${this.getAccountApiBaseUrl()}/auth/mobile/me`,
        undefined,
        {
          'Authorization': `Bearer ${accessToken}`,
        }
      );
      return accessToken;
    } catch (error) {
      const message = this.getErrorMessage(error).toLowerCase();
      if (!message.includes('401') && !message.includes('403') && !message.includes('expired')) {
        throw error;
      }
    }

    return this.refreshAccessToken();
  }

  public async requestJsonWithToken<T>(
    token: string,
    method: string,
    path: string,
    body?: BodyInit | Record<string, unknown>,
    init?: { headers?: Record<string, string> }
  ): Promise<T> {
    const url = `${this.getAccountApiBaseUrl()}${path}`;
    const headers: Record<string, string> = {
      'Accept': 'application/json',
      'Authorization': `Bearer ${token}`,
      ...(init?.headers || {}),
    };

    let finalBody: BodyInit | Record<string, unknown> | undefined;
    if (body instanceof FormData) {
      finalBody = body;
    } else if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
      finalBody = body;
    }

    return this.requestExternalJson<T>(method, url, finalBody, headers);
  }

  public async requestJson<T>(
    method: string,
    path: string,
    body?: BodyInit | Record<string, unknown>,
    init?: { headers?: Record<string, string> }
  ): Promise<T> {
    const currentToken = (await this.getAccessToken()).trim();
    if (currentToken === '') {
      throw new Error('Sign in to Osirus.AI first.');
    }

    try {
      return await this.requestJsonWithToken<T>(currentToken, method, path, body, init);
    } catch (error) {
      const message = this.getErrorMessage(error).toLowerCase();
      if (!message.includes('401') && !message.includes('403') && !message.includes('expired')) {
        throw error;
      }
    }

    const refreshedToken = await this.refreshAccessToken();
    return this.requestJsonWithToken<T>(refreshedToken, method, path, body, init);
  }

  private async fetchOrgMemberships(token: string): Promise<OsirusOrgMembership[]> {
    const payload = this.normalizeApiData(await this.requestJsonWithToken<any>(token, 'GET', '/orgs'));
    const memberships = Array.isArray(payload?.memberships)
      ? payload.memberships
      : Array.isArray(payload?.results)
        ? payload.results
        : [];

    return memberships
      .map((membership: any) => ({
        id: String(membership?.id || '').trim(),
        orgId: String(membership?.orgId || membership?.org?.id || '').trim(),
        role: String(membership?.role || '').trim() || undefined,
        org: membership?.org
          ? {
              id: String(membership.org.id || membership?.orgId || '').trim(),
              name: String(membership.org.name || '').trim() || undefined,
              slug: String(membership.org.slug || '').trim() || undefined,
            }
          : undefined,
      }))
      .filter((membership: OsirusOrgMembership) => membership.orgId !== '');
  }

  private async getActiveOrgId(token: string): Promise<string> {
    const payload = this.normalizeApiData(
      await this.requestJsonWithToken<OsirusActiveOrgResponse>(token, 'GET', '/orgs/active')
    );
    return String(payload?.orgId || payload?.org_id || '').trim();
  }

  private async setActiveOrg(token: string, orgId: string): Promise<string> {
    const payload = this.normalizeApiData(
      await this.requestJsonWithToken<OsirusActiveOrgResponse>(token, 'POST', '/orgs/active', { org_id: orgId })
    );
    const nextAccessToken = String(payload?.accessToken || payload?.access_token || '').trim();
    const nextRefreshToken = String(payload?.refreshToken || payload?.refresh_token || '').trim();
    if (nextAccessToken && nextRefreshToken) {
      await this.setAuthTokens({
        accessToken: nextAccessToken,
        refreshToken: nextRefreshToken,
      });
      this.outputChannel?.appendLine('[bridge] rotated Osirus mobile tokens after org switch');
    }
    return String(payload?.orgId || payload?.org_id || orgId).trim();
  }

  private async refreshAccessToken(): Promise<string> {
    const refreshToken = (await this.getRefreshToken()).trim();
    if (refreshToken === '') {
      throw new Error('No Osirus refresh token is available. Sign in again.');
    }

    let payload: OsirusMobileRefreshResponse;
    try {
      payload = await this.requestExternalJson<OsirusMobileRefreshResponse>(
        'POST',
        `${this.getAccountApiBaseUrl()}/auth/mobile/refresh`,
        { refreshToken }
      );
    } catch (error) {
      const message = this.getErrorMessage(error).toLowerCase();
      if (message.includes('422') || message.includes('401') || message.includes('403') || message.includes('invalid refresh token')) {
        await this.clearAuthTokens();
        await this.clearOpenChatState();
        this.refreshSidebar();
        try {
          return await this.signInWithStoredCredentials();
        } catch (_signInError) {
          throw new Error('Your Osirus.AI session expired. Sign in again from the sidebar.');
        }
      }
      throw error;
    }

    const accessToken = String(payload.access_token || '').trim();
    const nextRefreshToken = String(payload.refresh_token || '').trim();
    if (!accessToken || !nextRefreshToken) {
      throw new Error('Osirus token refresh did not return new tokens.');
    }

    await this.setAuthTokens({ accessToken, refreshToken: nextRefreshToken });
    try {
      await this.ensureActiveOrgSelection({ promptUser: false, tokenOverride: accessToken });
    } catch (error) {
      this.outputChannel?.appendLine(`[bridge] Osirus org refresh warning: ${this.getErrorMessage(error)}`);
    }
    this.outputChannel?.appendLine('[bridge] refreshed Osirus.AI account token');
    return accessToken;
  }

  private async signInWithStoredCredentials(): Promise<string> {
    const email = (await this.getEmail()).trim();
    const password = await this.getPassword();
    if (!email || !password) {
      throw new Error('Stored Osirus credentials are not available. Sign in again from the sidebar.');
    }

    const baseUrl = this.getAccountApiBaseUrl();
    const payload = await this.requestExternalJson<OsirusMobileSignInResponse>(
      'POST',
      `${baseUrl}/auth/mobile/signin`,
      {
        email,
        password,
        captcha: null,
      }
    );

    const accessToken = String(payload.access_token || '').trim();
    const refreshToken = String(payload.refresh_token || '').trim();
    if (!accessToken || !refreshToken) {
      throw new Error('Osirus sign-in did not return access and refresh tokens.');
    }

    await this.setAuthTokens({ accessToken, refreshToken });
    try {
      await this.ensureActiveOrgSelection({
        promptUser: false,
        tokenOverride: accessToken,
        preferredOrgId: String(payload.active_org_id || '').trim() || null,
      });
    } catch (error) {
      this.outputChannel?.appendLine(`[bridge] Osirus org restore warning: ${this.getErrorMessage(error)}`);
    }
    this.outputChannel?.appendLine('[bridge] restored Osirus.AI session using stored credentials');
    return accessToken;
  }

  private async getAccessToken(): Promise<string> {
    return (await this.context.secrets.get(OSIRUS_ACCESS_TOKEN_SECRET_KEY)) || '';
  }

  private async getRefreshToken(): Promise<string> {
    return (await this.context.secrets.get(OSIRUS_REFRESH_TOKEN_SECRET_KEY)) || '';
  }

  private async getEmail(): Promise<string> {
    return (await this.context.secrets.get(OSIRUS_EMAIL_SECRET_KEY)) || '';
  }

  private async getPassword(): Promise<string> {
    return (await this.context.secrets.get(OSIRUS_PASSWORD_SECRET_KEY)) || '';
  }

  private async setCredentials(credentials: { email: string; password: string }): Promise<void> {
    await this.context.secrets.store(OSIRUS_EMAIL_SECRET_KEY, credentials.email.trim());
    await this.context.secrets.store(OSIRUS_PASSWORD_SECRET_KEY, credentials.password);
  }

  private async clearCredentials(): Promise<void> {
    await this.context.secrets.delete(OSIRUS_EMAIL_SECRET_KEY);
    await this.context.secrets.delete(OSIRUS_PASSWORD_SECRET_KEY);
  }

  private async setAuthTokens(tokens: { accessToken: string; refreshToken: string }): Promise<void> {
    await this.context.secrets.store(OSIRUS_ACCESS_TOKEN_SECRET_KEY, tokens.accessToken.trim());
    await this.context.secrets.store(OSIRUS_REFRESH_TOKEN_SECRET_KEY, tokens.refreshToken.trim());
  }

  private async clearAuthTokens(): Promise<void> {
    await this.context.secrets.delete(OSIRUS_ACCESS_TOKEN_SECRET_KEY);
    await this.context.secrets.delete(OSIRUS_REFRESH_TOKEN_SECRET_KEY);
  }

  private async setStoredActiveOrg(orgId: string, orgName?: string): Promise<void> {
    const trimmedOrgId = orgId.trim();
    const trimmedOrgName = String(orgName || '').trim();
    await this.context.globalState.update(OSIRUS_ACTIVE_ORG_ID_STATE_KEY, trimmedOrgId || undefined);
    await this.context.globalState.update(OSIRUS_ACTIVE_ORG_NAME_STATE_KEY, trimmedOrgName || undefined);
  }

  private getOrgLabel(membership: OsirusOrgMembership): string {
    return String(membership.org?.name || membership.org?.slug || membership.orgId || membership.id || '').trim();
  }

  private normalizeApiData(payload: any): any {
    if (Array.isArray(payload)) {
      return payload.map((item) => this.normalizeApiData(item));
    }

    if (!payload || typeof payload !== 'object') {
      return payload;
    }

    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(payload)) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      out[camelKey] = this.normalizeApiData(value);
    }
    return out;
  }

  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => {
      setTimeout(resolve, ms);
    });
  }
}
