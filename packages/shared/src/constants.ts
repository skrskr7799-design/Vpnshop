export const CURRENCIES = ["RUB", "USD", "XTR"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const PAYMENT_PROVIDERS = ["PLATEGA", "CRYPTO", "TELEGRAM_STARS"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const AUTH_PROVIDERS = ["EMAIL", "GOOGLE", "TELEGRAM"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];

// Провайдеры внешнего входа (OAuth/OIDC), так они называются в URL
export const OAUTH_PROVIDERS = ["google", "telegram"] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];
