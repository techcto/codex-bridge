export class AuthService {
  constructor(deps) {
    this.deps = deps;
    this.activeDeviceAuth = null;
    this.cachedLoginStatusSummary = null;
    this.loginStatusPromise = null;
  }

  invalidateLoginStatusCache() {
    this.cachedLoginStatusSummary = null;
    this.loginStatusPromise = null;
  }

  getDeviceAuthState() {
    if (!this.activeDeviceAuth) {
      return null;
    }

    return {
      verification_url: this.activeDeviceAuth.verificationUrl,
      user_code: this.activeDeviceAuth.userCode,
      status: this.activeDeviceAuth.status,
      issued_at: this.activeDeviceAuth.issuedAt,
      expires_in_minutes: 15,
      error: this.activeDeviceAuth.error || null,
    };
  }

  async ensureDeviceAuth() {
    if (!this.deps.runtimeRequiresLogin()) {
      return {
        verification_url: '',
        user_code: '',
        status: 'complete',
        issued_at: Date.now(),
        expires_in_minutes: 0,
        error: null,
      };
    }

    if (this.deps.runtimeKind === 'app_server_adapter') {
      return this.ensureDeviceAuthViaAppServer();
    }

    if (this.activeDeviceAuth && ['pending', 'ready'].includes(this.activeDeviceAuth.status)) {
      return this.activeDeviceAuth.promise;
    }

    this.invalidateLoginStatusCache();

    this.activeDeviceAuth = {
      status: 'pending',
      verificationUrl: '',
      userCode: '',
      issuedAt: Date.now(),
      error: null,
      child: null,
      promise: null,
    };

    this.activeDeviceAuth.promise = (async () => {
      const child = await this.deps.spawnCodex(['login', '--device-auth']);

      return new Promise((resolve, reject) => {
        this.activeDeviceAuth.child = child;
        this.activeDeviceAuth.exited = false;
        let stdout = '';
        let stderr = '';
        let resolved = false;

        const maybeResolve = () => {
          const cleanStdout = this.deps.stripAnsi(stdout);
          const urlMatch = cleanStdout.match(/https:\/\/auth\.openai\.com\/codex\/device/);
          const codeMatch = cleanStdout.match(/\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/);

          if (urlMatch && codeMatch && !resolved) {
            resolved = true;
            this.activeDeviceAuth.status = 'ready';
            this.activeDeviceAuth.verificationUrl = urlMatch[0];
            this.activeDeviceAuth.userCode = codeMatch[0];
            resolve(this.getDeviceAuthState());
          }
        };

        child.stdout.on('data', (chunk) => {
          stdout += chunk.toString();
          maybeResolve();
        });

        child.stderr.on('data', (chunk) => {
          stderr += chunk.toString();
        });

        child.on('exit', (code) => {
          this.activeDeviceAuth.exited = true;
          if (!resolved) {
            this.activeDeviceAuth.status = 'error';
            this.activeDeviceAuth.error = (stderr || stdout || `Device auth exited with code ${code ?? 0}`).trim();
            reject(new Error(this.activeDeviceAuth.error));
            return;
          }

          this.activeDeviceAuth.status = code === 0 ? 'complete' : 'ready';
        });

        child.on('error', (error) => {
          this.activeDeviceAuth.exited = true;
          this.activeDeviceAuth.status = 'error';
          this.activeDeviceAuth.error = error.message;
          reject(error);
        });
      });
    })();

    return this.activeDeviceAuth.promise;
  }

  async ensureDeviceAuthViaAppServer() {
    if (this.activeDeviceAuth && ['pending', 'ready'].includes(this.activeDeviceAuth.status)) {
      return this.activeDeviceAuth.promise;
    }

    this.invalidateLoginStatusCache();

    this.activeDeviceAuth = {
      status: 'pending',
      verificationUrl: '',
      userCode: '',
      issuedAt: Date.now(),
      error: null,
      child: null,
      promise: null,
      loginId: null,
      exited: false,
    };

    this.activeDeviceAuth.promise = (async () => {
      const client = await this.deps.getAppServerClient();
      const payload = await client.request('account/login/start', {
        type: 'chatgptDeviceCode',
      });

      if (!payload || payload.type !== 'chatgptDeviceCode') {
        throw new Error('Codex App Server did not return a device-code login flow.');
      }

      this.activeDeviceAuth.status = 'ready';
      this.activeDeviceAuth.verificationUrl = payload.verificationUrl || '';
      this.activeDeviceAuth.userCode = payload.userCode || '';
      this.activeDeviceAuth.loginId = payload.loginId || null;
      return this.getDeviceAuthState();
    })();

    return this.activeDeviceAuth.promise;
  }

  handleAppServerNotification(method, params = {}) {
    if (method !== 'account/login/completed') {
      return;
    }

    if (this.activeDeviceAuth && (!this.activeDeviceAuth.loginId || this.activeDeviceAuth.loginId === params.loginId)) {
      this.activeDeviceAuth.status = params.success ? 'complete' : 'error';
      this.activeDeviceAuth.error = params.success ? null : (params.error || 'Device authentication failed.');
      this.activeDeviceAuth.exited = true;
      this.invalidateLoginStatusCache();
    }
  }

  async finishPendingDeviceAuth() {
    if (this.deps.runtimeKind === 'app_server_adapter') {
      return false;
    }

    if (!this.activeDeviceAuth?.child || this.activeDeviceAuth.exited) {
      return false;
    }

    try {
      this.invalidateLoginStatusCache();
      this.activeDeviceAuth.child.stdin.write('\n');
      await this.deps.wait(1200);
      return true;
    } catch (_error) {
      return false;
    }
  }

  async loadLoginStatusSummary() {
    if (!this.deps.runtimeRequiresLogin()) {
      if (this.deps.getActiveRuntimeConfig().auth_mode === 'api_key' && !this.deps.runtimeHasDirectApiKey()) {
        return {
          logged_in: false,
          auth_mode: 'api_key',
          message: 'Direct API mode is selected but no provider API key is configured.',
        };
      }

      return {
        logged_in: true,
        auth_mode: this.deps.getRuntimeAuthState(),
        message: this.deps.getActiveRuntimeConfig().auth_mode === 'none'
          ? 'No login required for this runtime provider.'
          : 'Direct API mode active',
      };
    }

    if (this.deps.runtimeKind === 'app_server_adapter') {
      const client = await this.deps.getAppServerClient();
      const result = await client.request('account/read', {
        refreshToken: false,
      });
      const account = result?.account || null;

      if (!account) {
        return {
          logged_in: false,
          auth_mode: 'chatgpt',
          message: 'Not logged in',
        };
      }

      if (account.type === 'apiKey') {
        return {
          logged_in: true,
          auth_mode: 'api_key',
          message: 'API key mode active',
        };
      }

      return {
        logged_in: true,
        auth_mode: 'chatgpt',
        message: account.email ? `Logged in as ${account.email}` : 'ChatGPT sign-in active',
      };
    }

    const result = await (async () => {
      const child = await this.deps.spawnCodex(['login', 'status']);

      return new Promise((resolve) => {
        let output = '';

        child.stdout.on('data', (chunk) => {
          output += chunk.toString();
        });

        child.stderr.on('data', (chunk) => {
          output += chunk.toString();
        });

        child.on('exit', (code) => {
          resolve({
            code: code ?? 1,
            output: output.trim(),
          });
        });

        child.on('error', (error) => {
          resolve({
            code: 1,
            output: error.message,
          });
        });
      });
    })();

    return {
      logged_in: result.code === 0 && !/not logged in/i.test(result.output),
      auth_mode: 'chatgpt',
      message: result.output || 'Unknown login status',
    };
  }

  async getLoginStatus({ force = false } = {}) {
    if (!this.deps.runtimeRequiresLogin()) {
      return {
        ...(await this.loadLoginStatusSummary()),
        device_auth: this.getDeviceAuthState(),
      };
    }

    const now = Date.now();
    if (!force && this.cachedLoginStatusSummary && this.cachedLoginStatusSummary.expiresAt > now) {
      return {
        ...this.cachedLoginStatusSummary.value,
        device_auth: this.getDeviceAuthState(),
      };
    }

    if (!force && this.loginStatusPromise) {
      const value = await this.loginStatusPromise;
      return {
        ...value,
        device_auth: this.getDeviceAuthState(),
      };
    }

    this.loginStatusPromise = this.loadLoginStatusSummary()
      .then((value) => {
        this.cachedLoginStatusSummary = {
          value,
          expiresAt: Date.now() + this.deps.loginStatusCacheTtlMs,
        };
        this.loginStatusPromise = null;
        return value;
      })
      .catch((error) => {
        this.loginStatusPromise = null;
        throw error;
      });

    const value = await this.loginStatusPromise;
    return {
      ...value,
      device_auth: this.getDeviceAuthState(),
    };
  }

  async getLoginStatusWithFinalize() {
    let loginStatus = await this.getLoginStatus();

    if (!loginStatus.logged_in && this.activeDeviceAuth?.status === 'ready') {
      await this.finishPendingDeviceAuth();
      loginStatus = await this.getLoginStatus({ force: true });
    }

    return loginStatus;
  }

  async getLoginStatusForHealth(timeoutMs = 1200) {
    try {
      return await Promise.race([
        this.getLoginStatusWithFinalize(),
        this.deps.wait(timeoutMs).then(() => ({
          logged_in: false,
          auth_mode: this.deps.getRuntimeAuthState(),
          message: 'Login status check timed out.',
        })),
      ]);
    } catch (error) {
      return {
        logged_in: false,
        auth_mode: this.deps.getRuntimeAuthState(),
        message: error instanceof Error ? error.message : 'Unable to determine login status.',
      };
    }
  }
}
