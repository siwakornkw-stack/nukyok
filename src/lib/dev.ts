import "server-only";

// Local testing without LINE: log in as any user from /login. Never in production.
export const devLoginOn = () => process.env.DEV_LOGIN === "1" && process.env.NODE_ENV !== "production";
