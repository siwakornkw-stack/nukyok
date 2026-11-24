// Client-safe: URL of a stored file (served by /api/files/<key> to signed-in users).
export const fileUrl = (key: string) => `/api/files/${key}`;
