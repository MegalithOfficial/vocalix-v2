use anyhow::{anyhow, Result};
use chrono::{DateTime, Utc};
use keyring::Entry;
use reqwest;
use serde::{Deserialize, Serialize};
use std::time::Duration;

// Twitch OAuth2 configuration
const TWITCH_DEVICE_URL: &str = "https://id.twitch.tv/oauth2/device";
const TWITCH_TOKEN_URL: &str = "https://id.twitch.tv/oauth2/token";
const TWITCH_VALIDATE_URL: &str = "https://id.twitch.tv/oauth2/validate";
const TWITCH_REVOKE_URL: &str = "https://id.twitch.tv/oauth2/revoke";

// Required scopes for channel point redemptions and basic user info
const DEFAULT_SCOPES: &[&str] = &[
    "channel:read:redemptions",
    "channel:manage:redemptions",
    "user:read:email",
    "user:read:chat",
    "user:write:chat",
    "moderator:read:followers", // Updated scope for follows
    "channel:read:subscriptions",
    "bits:read",
];

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchConfig {
    pub client_id: String,
    pub client_secret: Option<String>, // Optional for public clients
    pub scopes: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwitchTokens {
    pub access_token: String,
    pub refresh_token: Option<String>,
    pub expires_at: DateTime<Utc>,
    pub token_type: String,
    pub scope: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DeviceCodeResponse {
    pub device_code: String,
    pub expires_in: i64,
    pub interval: i64,
    pub user_code: String,
    pub verification_uri: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenResponse {
    access_token: String,
    refresh_token: Option<String>,
    expires_in: i64,
    token_type: String,
    scope: Vec<String>,
}

#[derive(Debug, Serialize, Deserialize)]
struct TokenErrorResponse {
    error: String,
    error_description: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct ValidationResponse {
    pub client_id: String,
    pub login: Option<String>,
    pub scopes: Vec<String>,
    pub user_id: Option<String>,
    pub expires_in: i64,
}

#[derive(Debug, Serialize, Deserialize)]
pub struct UserInfo {
    pub id: String,
    pub login: String,
    pub display_name: String,
    pub email: Option<String>,
}

#[derive(Clone)]
pub struct TwitchOAuth {
    pub config: TwitchConfig,
    http_client: reqwest::Client,
}

impl TwitchOAuth {
    pub fn new(client_id: String, client_secret: Option<String>) -> Self {
        let config = TwitchConfig {
            client_id,
            client_secret,
            scopes: DEFAULT_SCOPES.iter().map(|s| s.to_string()).collect(),
        };

        Self {
            config,
            http_client: reqwest::Client::new(),
        }
    }

    /// Start the Device Code Grant flow
    pub async fn start_device_flow(&self) -> Result<DeviceCodeResponse> {
        println!("Starting Twitch Device Code Grant flow...");

        let params = [
            ("client_id", self.config.client_id.as_str()),
            ("scopes", &self.config.scopes.join(" ")),
        ];

        let response = self
            .http_client
            .post(TWITCH_DEVICE_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&params)
            .send()
            .await?;

        let status = response.status();
        let response_text = response.text().await?;

        if !status.is_success() {
            // Try to parse error response
            if let Ok(error_response) = serde_json::from_str::<TokenErrorResponse>(&response_text) {
                return Err(anyhow!(
                    "Device flow start failed: {} - {}",
                    error_response.error,
                    error_response
                        .error_description
                        .unwrap_or_else(|| "Unknown error".to_string())
                ));
            } else {
                return Err(anyhow!(
                    "Device flow start failed: HTTP {} - {}",
                    status,
                    response_text
                ));
            }
        }

        let device_response: DeviceCodeResponse = serde_json::from_str(&response_text)
            .map_err(|e| anyhow!("Failed to parse device flow response: {}", e))?;

        Ok(device_response)
    }

    /// Poll for tokens using device code
    pub async fn poll_for_tokens(
        &self,
        device_code: &str,
        interval: Duration,
    ) -> Result<TwitchTokens> {
        println!("Polling for tokens...");

        let scopes_joined = self.config.scopes.join(" ");
        let mut params = vec![
            ("client_id", self.config.client_id.as_str()),
            ("scopes", &scopes_joined),
            ("device_code", device_code),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ];

        // Add client_secret if this is a confidential client
        let client_secret_str;
        if let Some(ref secret) = self.config.client_secret {
            client_secret_str = secret.clone();
            params.push(("client_secret", &client_secret_str));
        }

        let mut poll_interval = interval;
        loop {
            tokio::time::sleep(poll_interval).await;

            let response = self
                .http_client
                .post(TWITCH_TOKEN_URL)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .form(&params)
                .send()
                .await?;

            let status = response.status();
            let response_text = response.text().await?;

            if status.is_success() {
                let token_response: TokenResponse = serde_json::from_str(&response_text)
                    .map_err(|e| anyhow!("Failed to parse token response: {}", e))?;

                let expires_at = Utc::now() + chrono::Duration::seconds(token_response.expires_in);

                return Ok(TwitchTokens {
                    access_token: token_response.access_token,
                    refresh_token: token_response.refresh_token,
                    expires_at,
                    token_type: token_response.token_type,
                    scope: token_response.scope,
                });
            } else {
                // Parse error response
                if let Ok(error_response) =
                    serde_json::from_str::<TokenErrorResponse>(&response_text)
                {
                    match error_response.error.as_str() {
                        "authorization_pending" => {
                            println!("Authorization pending, continuing to poll...");
                            continue;
                        }
                        "slow_down" => {
                            println!("Polling too fast, slowing down...");
                            // Increase the polling interval when told to slow down
                            poll_interval = poll_interval + Duration::from_secs(5);
                            continue;
                        }
                        "expired_token" => {
                            return Err(anyhow!("Device code expired. Please start the authentication process again."));
                        }
                        "access_denied" => {
                            return Err(anyhow!("User denied authorization."));
                        }
                        "invalid_device_code" => {
                            return Err(anyhow!(
                                "Invalid device code. Please restart the authentication process."
                            ));
                        }
                        _ => {
                            return Err(anyhow!(
                                "Authentication error: {} - {}",
                                error_response.error,
                                error_response
                                    .error_description
                                    .unwrap_or_else(|| "Unknown error".to_string())
                            ));
                        }
                    }
                } else {
                    // Handle non-JSON error responses
                    if status.as_u16() == 400 {
                        // Check for common error messages in the response text
                        if response_text.contains("authorization_pending") {
                            println!("Authorization pending, continuing to poll...");
                            continue;
                        } else if response_text.contains("slow_down") {
                            println!("Polling too fast, slowing down...");
                            poll_interval = poll_interval + Duration::from_secs(5);
                            continue;
                        } else if response_text.contains("expired_token")
                            || response_text.contains("invalid device code")
                        {
                            return Err(anyhow!("Device code expired or invalid. Please restart the authentication process."));
                        }
                    }
                    return Err(anyhow!(
                        "Token polling failed: HTTP {} - {}",
                        status,
                        response_text
                    ));
                }
            }
        }
    }

    /// Refresh an expired access token using the refresh token
    pub async fn refresh_tokens(&self, refresh_token: &str) -> Result<TwitchTokens> {
        let mut params = vec![
            ("client_id", self.config.client_id.as_str()),
            ("grant_type", "refresh_token"),
            ("refresh_token", refresh_token),
        ];

        // Add client_secret if this is a confidential client
        let client_secret_str;
        if let Some(ref secret) = self.config.client_secret {
            client_secret_str = secret.clone();
            params.push(("client_secret", &client_secret_str));
        }

        let response = self
            .http_client
            .post(TWITCH_TOKEN_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .header("Accept", "application/json")
            .form(&params)
            .send()
            .await?;

        let status = response.status();
        let response_text = response.text().await?;

        if !status.is_success() {
            // Try to parse error response
            if let Ok(error_response) = serde_json::from_str::<TokenErrorResponse>(&response_text) {
                return Err(anyhow!(
                    "Token refresh failed: {} - {}",
                    error_response.error,
                    error_response
                        .error_description
                        .unwrap_or_else(|| "Unknown error".to_string())
                ));
            } else {
                return Err(anyhow!(
                    "Token refresh failed: HTTP {} - {}",
                    status,
                    response_text
                ));
            }
        }

        let token_response: TokenResponse = serde_json::from_str(&response_text)
            .map_err(|e| anyhow!("Failed to parse refresh token response: {}", e))?;
        let expires_at = Utc::now() + chrono::Duration::seconds(token_response.expires_in);

        Ok(TwitchTokens {
            access_token: token_response.access_token,
            refresh_token: token_response
                .refresh_token
                .or_else(|| Some(refresh_token.to_string())),
            expires_at,
            token_type: token_response.token_type,
            scope: token_response.scope,
        })
    }

    /// Validate a token to check if it's still valid
    pub async fn validate_token(&self, access_token: &str) -> Result<ValidationResponse> {
        let response = self
            .http_client
            .get(TWITCH_VALIDATE_URL)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await?;

        let status = response.status();
        let response_text = response.text().await?;

        if !status.is_success() {
            if status.as_u16() == 401 {
                return Err(anyhow!("Token is invalid or expired"));
            }
            // Try to parse error response
            if let Ok(error_response) = serde_json::from_str::<TokenErrorResponse>(&response_text) {
                return Err(anyhow!(
                    "Token validation failed: {} - {}",
                    error_response.error,
                    error_response
                        .error_description
                        .unwrap_or_else(|| "Unknown error".to_string())
                ));
            } else {
                return Err(anyhow!(
                    "Token validation failed: HTTP {} - {}",
                    status,
                    response_text
                ));
            }
        }

        let validation: ValidationResponse = serde_json::from_str(&response_text)
            .map_err(|e| anyhow!("Failed to parse validation response: {}", e))?;
        Ok(validation)
    }

    /// Revoke a token (logout)
    pub async fn revoke_token(&self, access_token: &str) -> Result<()> {
        let params = [
            ("client_id", self.config.client_id.as_str()),
            ("token", access_token),
        ];

        let response = self
            .http_client
            .post(TWITCH_REVOKE_URL)
            .header("Content-Type", "application/x-www-form-urlencoded")
            .form(&params)
            .send()
            .await?;

        let status = response.status();

        if !status.is_success() {
            let response_text = response.text().await?;
            // Try to parse error response
            if let Ok(error_response) = serde_json::from_str::<TokenErrorResponse>(&response_text) {
                return Err(anyhow!(
                    "Token revocation failed: {} - {}",
                    error_response.error,
                    error_response
                        .error_description
                        .unwrap_or_else(|| "Unknown error".to_string())
                ));
            } else {
                return Err(anyhow!(
                    "Token revocation failed: HTTP {} - {}",
                    status,
                    response_text
                ));
            }
        }

        Ok(())
    }

    /// Get user information
    pub async fn get_user_info(&self, access_token: &str) -> Result<UserInfo> {
        let response = self
            .http_client
            .get("https://api.twitch.tv/helix/users")
            .header("Client-Id", &self.config.client_id)
            .header("Authorization", format!("Bearer {}", access_token))
            .send()
            .await?;

        let status = response.status();
        let response_text = response.text().await?;

        if !status.is_success() {
            if status.as_u16() == 401 {
                return Err(anyhow!("Invalid or expired token"));
            }
            // Try to parse error response
            if let Ok(error_response) = serde_json::from_str::<serde_json::Value>(&response_text) {
                if let Some(message) = error_response.get("message").and_then(|m| m.as_str()) {
                    return Err(anyhow!("Failed to get user info: {}", message));
                }
            }
            return Err(anyhow!(
                "Failed to get user info (get_user_info): HTTP {} - {}",
                status,
                response_text
            ));
        }

        #[derive(Deserialize)]
        struct UsersResponse {
            data: Vec<UserInfo>,
        }

        let users_response: UsersResponse = serde_json::from_str(&response_text)
            .map_err(|e| anyhow!("Failed to parse user info response: {}", e))?;

        users_response
            .data
            .into_iter()
            .next()
            .ok_or_else(|| anyhow!("No user data returned"))
    }
}

/// Secure token storage using system keyring
pub struct TwitchTokenStorage;

impl TwitchTokenStorage {
    const SERVICE_NAME: &'static str = "Vocalix-Twitch";
    const USERNAME: &'static str = "oauth-tokens";

    pub fn save_tokens(tokens: &TwitchTokens) -> Result<()> {
        let entry = Entry::new(Self::SERVICE_NAME, Self::USERNAME)?;
        let json = serde_json::to_string(tokens)?;
        entry.set_password(&json)?;
        Ok(())
    }

    pub fn load_tokens() -> Result<TwitchTokens> {
        let entry = Entry::new(Self::SERVICE_NAME, Self::USERNAME)?;
        let json = entry.get_password()?;
        let tokens: TwitchTokens = serde_json::from_str(&json)?;
        Ok(tokens)
    }

    pub fn delete_tokens() -> Result<()> {
        let entry = Entry::new(Self::SERVICE_NAME, Self::USERNAME)?;
        entry.delete_credential()?;
        Ok(())
    }

    pub fn tokens_exist() -> bool {
        let entry = Entry::new(Self::SERVICE_NAME, Self::USERNAME);
        if let Ok(entry) = entry {
            entry.get_password().is_ok()
        } else {
            false
        }
    }
}

/// Secure client credential storage using system keyring
pub struct TwitchCredentialStorage;

impl TwitchCredentialStorage {
    const SERVICE_NAME: &'static str = "Vocalix-Twitch";
    const USERNAME: &'static str = "client-credentials";

    pub fn save_credentials(client_id: &str, client_secret: Option<&str>) -> Result<()> {
        let entry = Entry::new(Self::SERVICE_NAME, Self::USERNAME)?;
        let credentials = serde_json::json!({
            "client_id": client_id,
            "client_secret": client_secret
        });
        let json = serde_json::to_string(&credentials)?;
        entry.set_password(&json)?;
        Ok(())
    }

    pub fn load_credentials() -> Result<(String, Option<String>)> {
        let entry = Entry::new(Self::SERVICE_NAME, Self::USERNAME)?;
        let json = entry.get_password()?;
        let credentials: serde_json::Value = serde_json::from_str(&json)?;

        let client_id = credentials["client_id"]
            .as_str()
            .ok_or_else(|| anyhow!("Invalid client_id in stored credentials"))?
            .to_string();

        let client_secret = credentials["client_secret"].as_str().map(|s| s.to_string());

        Ok((client_id, client_secret))
    }

    pub fn delete_credentials() -> Result<()> {
        let entry = Entry::new(Self::SERVICE_NAME, Self::USERNAME)?;
        entry.delete_credential()?;
        Ok(())
    }

    pub fn credentials_exist() -> bool {
        let entry = Entry::new(Self::SERVICE_NAME, Self::USERNAME);
        if let Ok(entry) = entry {
            entry.get_password().is_ok()
        } else {
            false
        }
    }
}

/// High-level OAuth manager that handles the complete Device Code Grant flow
#[derive(Clone)]
pub struct TwitchAuthManager {
    oauth: TwitchOAuth,
}

impl TwitchAuthManager {
    pub fn new(client_id: String, client_secret: Option<String>) -> Self {
        Self {
            oauth: TwitchOAuth::new(client_id, client_secret),
        }
    }

    /// Complete Device Code Grant flow
    pub async fn authenticate(&self) -> Result<(TwitchTokens, String)> {
        println!("Starting Twitch Device Code Grant authentication...");

        // Start the device flow
        let device_response = self.oauth.start_device_flow().await?;

        // Create user instructions with the verification URI
        let user_instructions = if device_response.verification_uri.contains("device-code=") {
            // The URI already contains the device code
            format!(
                "Please visit {} to complete authentication",
                device_response.verification_uri
            )
        } else {
            // Need to provide both URI and code separately
            format!(
                "Please visit {} and enter code: {}",
                device_response.verification_uri, device_response.user_code
            )
        };

        println!("Please visit: {}", device_response.verification_uri);
        println!("User code: {}", device_response.user_code);

        // Poll for tokens
        let poll_interval = Duration::from_secs(device_response.interval as u64);
        let tokens = self
            .oauth
            .poll_for_tokens(&device_response.device_code, poll_interval)
            .await?;

        // Save tokens securely
        TwitchTokenStorage::save_tokens(&tokens)?;
        println!("Authentication successful! Tokens saved securely.");

        Ok((tokens, user_instructions))
    }

    /// Start Device Code Grant flow and return device code info immediately
    pub async fn start_device_flow_async(&self) -> Result<DeviceCodeResponse> {
        println!("Starting Twitch Device Code Grant flow...");
        self.oauth.start_device_flow().await
    }

    /// Complete the polling phase of Device Code Grant flow
    pub async fn complete_device_flow(
        &self,
        device_response: &DeviceCodeResponse,
    ) -> Result<TwitchTokens> {
        println!("Starting token polling...");

        // Poll for tokens
        let poll_interval = Duration::from_secs(device_response.interval as u64);
        let tokens = self
            .oauth
            .poll_for_tokens(&device_response.device_code, poll_interval)
            .await?;

        // Save tokens securely
        TwitchTokenStorage::save_tokens(&tokens)?;
        println!("Authentication successful! Tokens saved securely.");

        Ok(tokens)
    }

    /// Get valid tokens, refreshing if necessary
    pub async fn get_valid_tokens(&self) -> Result<TwitchTokens> {
        // Try to load existing tokens
        let mut tokens = TwitchTokenStorage::load_tokens()
            .map_err(|_| anyhow!("No saved tokens found. Please authenticate first."))?;

        // Check if tokens are still valid (with 5 minute buffer)
        let expires_soon = tokens.expires_at < (Utc::now() + chrono::Duration::minutes(5));

        if expires_soon {
            if let Some(refresh_token) = &tokens.refresh_token {
                println!("Access token expires soon, refreshing...");
                tokens = self.oauth.refresh_tokens(refresh_token).await?;
                TwitchTokenStorage::save_tokens(&tokens)?;
                println!("Tokens refreshed successfully!");
            } else {
                return Err(anyhow!(
                    "Token expired and no refresh token available. Please re-authenticate."
                ));
            }
        }

        Ok(tokens)
    }

    /// Validate current tokens
    pub async fn validate_current_tokens(&self) -> Result<ValidationResponse> {
        let tokens = self.get_valid_tokens().await?;
        self.oauth.validate_token(&tokens.access_token).await
    }

    /// Get user information
    pub async fn get_user_info(&self) -> Result<UserInfo> {
        let tokens = self.get_valid_tokens().await?;
        self.oauth.get_user_info(&tokens.access_token).await
    }

    /// Sign out (revoke tokens and delete from storage)
    pub async fn sign_out(&self) -> Result<()> {
        if let Ok(tokens) = TwitchTokenStorage::load_tokens() {
            // Try to revoke the token (best effort)
            let _ = self.oauth.revoke_token(&tokens.access_token).await;
        }

        // Delete stored tokens
        TwitchTokenStorage::delete_tokens()?;
        println!("Signed out successfully!");
        Ok(())
    }

    /// Check if user is authenticated
    pub fn is_authenticated() -> bool {
        TwitchTokenStorage::tokens_exist()
    }

    /// Get the client ID for API calls
    pub fn get_client_id(&self) -> &str {
        &self.oauth.config.client_id
    }

    /// Save client credentials to keyring
    pub fn save_client_credentials(client_id: &str, client_secret: Option<&str>) -> Result<()> {
        TwitchCredentialStorage::save_credentials(client_id, client_secret)
    }

    /// Load client credentials from keyring
    pub fn load_client_credentials() -> Result<(String, Option<String>)> {
        TwitchCredentialStorage::load_credentials()
    }

    /// Delete client credentials from keyring
    pub fn delete_client_credentials() -> Result<()> {
        TwitchCredentialStorage::delete_credentials()
    }

    /// Check if client credentials are saved
    pub fn has_saved_credentials() -> bool {
        TwitchCredentialStorage::credentials_exist()
    }

    /// Create TwitchAuthManager from saved credentials
    pub fn from_saved_credentials() -> Result<Self> {
        let (client_id, client_secret) = Self::load_client_credentials()?;
        Ok(Self::new(client_id, client_secret))
    }

    /// Get the current authentication status
    pub async fn get_auth_status(&self) -> Result<AuthStatus> {
        // Check if tokens exist
        if !TwitchTokenStorage::tokens_exist() {
            return Ok(AuthStatus::NotAuthenticated);
        }

        // Try to load tokens
        let tokens = match TwitchTokenStorage::load_tokens() {
            Ok(tokens) => tokens,
            Err(_) => return Ok(AuthStatus::NotAuthenticated),
        };

        // Check if tokens are still valid (with 5 minute buffer)
        let expires_soon = tokens.expires_at < (Utc::now() + chrono::Duration::minutes(5));
        let is_expired = tokens.expires_at < Utc::now();

        // If expired, try to validate with API to be sure
        if is_expired {
            match self.oauth.validate_token(&tokens.access_token).await {
                Ok(_) => {
                    // Token is still valid according to API, but close to expiry
                    if expires_soon {
                        Ok(AuthStatus::ExpiringSoon(tokens.expires_at))
                    } else {
                        Ok(AuthStatus::Valid)
                    }
                }
                Err(_) => Ok(AuthStatus::Invalid),
            }
        } else if expires_soon {
            Ok(AuthStatus::ExpiringSoon(tokens.expires_at))
        } else {
            // Validate with API to be sure
            match self.oauth.validate_token(&tokens.access_token).await {
                Ok(_) => Ok(AuthStatus::Valid),
                Err(_) => Ok(AuthStatus::Invalid),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_device_flow_start() {
        // This test requires a real client ID to work
        // let oauth = TwitchOAuth::new("your_client_id".to_string(), None);
        // let device_response = oauth.start_device_flow().await.unwrap();
        // assert!(!device_response.device_code.is_empty());
        // assert!(!device_response.user_code.is_empty());
        // assert!(device_response.verification_uri.contains("twitch.tv"));
    }

    #[test]
    fn test_token_storage() {
        let tokens = TwitchTokens {
            access_token: "test_access_token".to_string(),
            refresh_token: Some("test_refresh_token".to_string()),
            expires_at: Utc::now() + chrono::Duration::hours(1),
            token_type: "bearer".to_string(),
            scope: vec!["channel:read:redemptions".to_string()],
        };

        // This test might fail in CI/CD environments without keyring access
        if let Ok(_) = TwitchTokenStorage::save_tokens(&tokens) {
            let loaded = TwitchTokenStorage::load_tokens().unwrap();
            assert_eq!(loaded.access_token, tokens.access_token);
            assert_eq!(loaded.refresh_token, tokens.refresh_token);

            TwitchTokenStorage::delete_tokens().unwrap();
        }
    }

    #[test]
    fn test_scope_validation() {
        let auth_manager = TwitchAuthManager::new("test_client_id".to_string(), None);
        let scopes = &auth_manager.oauth.config.scopes;

        // Verify required scopes are present
        assert!(scopes.contains(&"channel:read:redemptions".to_string()));
        assert!(scopes.contains(&"user:read:email".to_string()));

        // Verify updated scopes
        assert!(scopes.contains(&"user:read:chat".to_string()));
        assert!(scopes.contains(&"user:write:chat".to_string()));
    }

    #[test]
    fn test_token_expiry_logic() {
        let tokens = TwitchTokens {
            access_token: "test_token".to_string(),
            refresh_token: Some("test_refresh".to_string()),
            expires_at: Utc::now() + chrono::Duration::minutes(2), // Expires in 2 minutes
            token_type: "bearer".to_string(),
            scope: vec!["test:scope".to_string()],
        };

        // Should be considered as expiring soon (within 5 minute buffer)
        let expires_soon = tokens.expires_at < (Utc::now() + chrono::Duration::minutes(5));
        assert!(expires_soon);
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum AuthStatus {
    NotAuthenticated,
    Invalid,
    Valid,
    ExpiringSoon(DateTime<Utc>),
}
