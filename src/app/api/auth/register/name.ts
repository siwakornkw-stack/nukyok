// A registration name: the company bot posts it to the Office group, where a link would become tappable. One
// line of letters (Thai or Latin, with their vowel and tone marks) and spaces, . - ' ( ) for titles and
// nicknames ("น.ส.", "(ต้น)"), 2-60 characters; no digits and no "x.com" (a dot right before a Latin letter).
export const nameOk = (name: string) => /^[\p{L}\p{M} .'()-]{2,60}$/u.test(name) && !/\.\p{Script=Latin}/u.test(name);
