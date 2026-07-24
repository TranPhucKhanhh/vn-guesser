// Auth0 Domain and Client ID are public SPA identifiers, not secrets.
// Never add the Auth0 Client Secret or Google Client Secret to this file.
window.GEOGUESSER_AUTH_CONFIG = Object.freeze({
  enabled: true,
  domain: "phuc-khanh.jp.auth0.com",
  clientId: "umgXNNqm6C03MQQYlVawTacrQENtIyGw",
  audience: "https://vietnam-geoguesser-r2-guard.my-slave.workers.dev",
  scope: "openid profile email"
});
