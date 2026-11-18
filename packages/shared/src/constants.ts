export const CURRENCIES = ["RUB", "USD", "XTR"] as const;
export type Currency = (typeof CURRENCIES)[number];

export const PAYMENT_PROVIDERS = ["PLATEGA", "CRYPTO", "TELEGRAM_STARS"] as const;
export type PaymentProvider = (typeof PAYMENT_PROVIDERS)[number];

export const AUTH_PROVIDERS = ["EMAIL", "GOOGLE", "TELEGRAM"] as const;
export type AuthProvider = (typeof AUTH_PROVIDERS)[number];
