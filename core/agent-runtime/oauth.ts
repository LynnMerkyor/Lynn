export interface OAuthTokens {
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

export interface OAuthCredentials {
  access?: string;
  refresh?: string;
  expires?: number;
  resourceUrl?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
  [key: string]: unknown;
}

export interface OAuthLoginCallbacks {
  onAuth?: (payload: { url: string; instructions?: string }) => void;
  onProgress?: (message: string) => void;
  signal?: AbortSignal;
  onUrl?: (url: string) => void;
  onCode?: (code: string, verificationUri?: string) => void;
  onStatus?: (status: string) => void;
  [key: string]: unknown;
}

export interface OAuthProvider {
  id?: string;
  name?: string;
  [key: string]: unknown;
}

export interface OAuthProviderInterface extends OAuthProvider {
  login?: (callbacks: OAuthLoginCallbacks) => Promise<OAuthCredentials>;
  refreshToken?: (credentials: OAuthCredentials) => Promise<OAuthCredentials>;
  getApiKey?: (credentials: OAuthCredentials) => string;
  modifyModels?: (models: any[], credentials: OAuthCredentials) => any[];
}

const providers = new Map<string, OAuthProvider>();

export function registerOAuthProvider(provider: OAuthProvider): void {
  const id = typeof provider.id === "string" && provider.id ? provider.id : typeof provider.name === "string" ? provider.name : "unknown";
  providers.set(id, provider);
}

export function getRegisteredOAuthProviders(): OAuthProvider[] {
  return [...providers.values()];
}
