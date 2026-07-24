(function () {
  const config = window.GEOGUESSER_AUTH_CONFIG || {};
  const auth_required = config.enabled === true;
  const elements = {
    gate: document.getElementById("authGate"),
    login_button: document.getElementById("authLoginButton"),
    signup_button: document.getElementById("authSignupButton"),
    message: document.getElementById("authMessage"),
    user_button: document.getElementById("authUserButton"),
    user_initials: document.getElementById("authUserInitials"),
    user_name: document.getElementById("authUserName"),
    menu: document.getElementById("modeMenu"),
    game: document.getElementById("gameApp"),
    menu_user_button: document.getElementById("menuAuthUserButton"),
    menu_user_initials: document.getElementById("menuAuthUserInitials"),
    menu_user_name: document.getElementById("menuAuthUserName"),
    account_view: document.getElementById("accountView"),
    account_close_button: document.getElementById("accountCloseButton"),
    account_avatar_initials: document.getElementById("accountAvatarInitials"),
    account_title: document.getElementById("accountTitle"),
    account_username: document.getElementById("accountUsername"),
    account_logout_button: document.getElementById("authLogoutButton"),
    account_message: document.getElementById("accountMessage")
  };

  let auth_client = null;
  let last_account_trigger = null;

  window.GEOGUESSER_GET_ACCESS_TOKEN = getAccessToken;
  window.GEOGUESSER_AUTH_READY = initializeAuth();

  async function initializeAuth() {
    if (!auth_required) {
      showGame();
      return { required: false, authenticated: false, user: null };
    }

    if (!config.domain || !config.clientId || !config.audience) {
      showAuthError("Thiếu Auth0 domain, client ID hoặc API audience trong auth-config.js.");
      return { required: true, authenticated: false, user: null };
    }

    if (!window.auth0?.createAuth0Client) {
      showAuthError("Không thể tải thư viện đăng nhập. Hãy kiểm tra kết nối mạng.");
      return { required: true, authenticated: false, user: null };
    }

    try {
      auth_client = await window.auth0.createAuth0Client({
        domain: config.domain,
        clientId: config.clientId,
        authorizationParams: {
          redirect_uri: window.location.origin,
          audience: config.audience,
          scope: config.scope || "openid profile email"
        }
      });

      if (hasAuthErrorParameters()) {
        const params = new URLSearchParams(window.location.search);
        const description = params.get("error_description") || params.get("error");
        clearAuthCallbackParameters();
        showAuthGate();
        elements.message.textContent = description || "Đăng nhập không thành công. Vui lòng thử lại.";
        return { required: true, authenticated: false, user: null };
      }

      if (hasAuthCallbackParameters()) {
        const result = await auth_client.handleRedirectCallback();
        const return_to = safeReturnPath(result.appState?.returnTo);
        window.history.replaceState({}, document.title, return_to);
      }

      const authenticated = await auth_client.isAuthenticated();
      if (!authenticated) {
        showAuthGate();
        return { required: true, authenticated: false, user: null };
      }

      const user = await auth_client.getUser();
      await getAccessToken();
      showAuthenticatedUser(user);
      showGame();
      return { required: true, authenticated: true, user };
    } catch (error) {
      console.error("Authentication initialization failed:", error);
      showAuthGate();
      elements.message.textContent = "Đăng nhập chưa thể hoàn tất. Vui lòng thử lại.";
      return { required: true, authenticated: false, user: null, error };
    }
  }

  function hasAuthErrorParameters() {
    return new URLSearchParams(window.location.search).has("error");
  }

  function hasAuthCallbackParameters() {
    const params = new URLSearchParams(window.location.search);
    return params.has("code") && params.has("state");
  }

  function clearAuthCallbackParameters() {
    window.history.replaceState({}, document.title, window.location.pathname);
  }

  function safeReturnPath(return_to) {
    if (
      typeof return_to !== "string" ||
      !return_to.startsWith("/") ||
      return_to.startsWith("//")
    ) {
      return window.location.pathname;
    }

    return return_to;
  }

  function currentReturnPath() {
    return `${window.location.pathname}${window.location.search}${window.location.hash}`;
  }

  async function getAccessToken() {
    if (!auth_client) {
      throw new Error("Auth0 has not finished initializing.");
    }

    return auth_client.getTokenSilently({
      authorizationParams: {
        audience: config.audience,
        scope: config.scope || "openid profile email"
      }
    });
  }

  function showGame() {
    elements.gate.hidden = true;
    elements.menu.hidden = false;
    elements.game.hidden = true;
    document.body.classList.remove("auth-pending");
  }

  function showAuthGate() {
    elements.gate.hidden = false;
    elements.message.textContent = "";
    elements.login_button.disabled = false;
    elements.signup_button.disabled = false;
  }

  function showAuthError(message) {
    elements.gate.hidden = false;
    elements.message.textContent = message;
    elements.login_button.disabled = true;
    elements.signup_button.disabled = true;
  }

  function showAuthenticatedUser(user) {
    const display_name = usernameFor(user);
    const initials = initialsFor(display_name);

    elements.user_initials.textContent = initials;
    elements.user_name.textContent = display_name;
    elements.user_button.title = `${display_name} - Tài khoản`;
    elements.user_button.hidden = false;
    elements.menu_user_initials.textContent = initials;
    elements.menu_user_name.textContent = display_name;
    elements.menu_user_button.title = `${display_name} - Tài khoản`;
    elements.menu_user_button.hidden = false;
    elements.account_avatar_initials.textContent = initials;
    elements.account_title.textContent = display_name;
    elements.account_username.textContent = display_name;
  }

  function usernameFor(user) {
    return (
      user?.preferred_username ||
      user?.nickname ||
      user?.name ||
      user?.email ||
      "Người chơi"
    );
  }

  function initialsFor(name) {
    return name
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part.charAt(0))
      .join("")
      .toUpperCase() || "U";
  }

  function openAccountView(event) {
    last_account_trigger = event.currentTarget;
    elements.account_view.hidden = false;
    elements.user_button.setAttribute("aria-expanded", "true");
    elements.menu_user_button.setAttribute("aria-expanded", "true");
    elements.account_message.textContent = "";
    elements.account_close_button.focus();
  }

  function closeAccountView() {
    elements.account_view.hidden = true;
    elements.user_button.setAttribute("aria-expanded", "false");
    elements.menu_user_button.setAttribute("aria-expanded", "false");
    last_account_trigger?.focus();
  }

  async function redirectToAuth(screen_hint) {
    if (!auth_client) return;

    elements.login_button.disabled = true;
    elements.signup_button.disabled = true;
    elements.message.textContent = "Đang chuyển đến trang đăng nhập...";

    try {
      await auth_client.loginWithRedirect({
        appState: {
          returnTo: currentReturnPath()
        },
        authorizationParams: {
          redirect_uri: window.location.origin,
          audience: config.audience,
          scope: config.scope || "openid profile email",
          ...(screen_hint ? { screen_hint } : {})
        }
      });
    } catch (error) {
      console.error("Authentication redirect failed:", error);
      elements.message.textContent = "Không thể mở trang đăng nhập. Vui lòng thử lại.";
      elements.login_button.disabled = false;
      elements.signup_button.disabled = false;
    }
  }

  elements.login_button.addEventListener("click", () => {
    redirectToAuth();
  });

  elements.signup_button.addEventListener("click", () => {
    redirectToAuth("signup");
  });

  elements.user_button.addEventListener("click", openAccountView);
  elements.menu_user_button.addEventListener("click", openAccountView);
  elements.account_close_button.addEventListener("click", closeAccountView);

  elements.account_view.addEventListener("click", (event) => {
    if (event.target === elements.account_view) closeAccountView();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !elements.account_view.hidden) {
      closeAccountView();
    }
  });

  elements.account_logout_button.addEventListener("click", async () => {
    if (!auth_client) return;

    elements.account_logout_button.disabled = true;
    elements.account_message.textContent = "Đang đăng xuất...";

    try {
      await auth_client.logout({
        logoutParams: {
          returnTo: window.location.origin
        }
      });
    } catch (error) {
      console.error("Logout failed:", error);
      elements.account_message.textContent = "Không thể đăng xuất. Vui lòng thử lại.";
      elements.account_logout_button.disabled = false;
    }
  });
})();
