// The password rules, in one place, because they are stated in three.
//
// The reset page, the forgot-password page's follow-on, and the signed-in
// change-password form all set a password, and each used to carry its own copy
// of "at least 6 characters" — as a magic number, a sentence, and a validation
// branch. Rules that are written down three times are rules that drift, and a
// form that enforces something it does not say is a form people fail twice
// before they learn why.
//
// So: PASSWORD_RULES is what the user is shown, validateNewPassword is what is
// enforced, and they are defined next to each other deliberately.

export const MIN_PASSWORD_LENGTH = 6;

/**
 * What we tell people, verbatim, before they type anything.
 *
 * Only rules that are actually enforced belong here. "Must not match a password
 * you have used before" is deliberately NOT in this list: Supabase Auth stores
 * only the current password hash and has no password-history feature, so the
 * strongest true statement is the one below about the current password. Adding
 * history means keeping our own table of past hashes and checking it server-side
 * — until that exists, claiming it here would be a promise the form cannot keep.
 */
export const PASSWORD_RULES = [
  `At least ${MIN_PASSWORD_LENGTH} characters.`,
  "Must be different from your current password.",
];

/** The same rules as one sentence, for places too tight for a list. */
export const PASSWORD_RULES_SENTENCE = `Must be at least ${MIN_PASSWORD_LENGTH} characters, and different from your current password.`;

/**
 * Validates a new password and its confirmation.
 *
 * Returns a message to show, or "" when the password is acceptable. Returning a
 * string rather than throwing keeps this usable directly in a submit handler,
 * which is the only place it is called.
 *
 * Note what is NOT checked here: whether the password matches the current one.
 * The client cannot know the current password — on the reset page there is not
 * even a user to ask — so that rule is enforced by Supabase and surfaced by
 * describePasswordError below.
 */
export const validateNewPassword = (password, confirm) => {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  if (password !== confirm) return "Those passwords do not match.";
  return "";
};

/**
 * Turns a failed password update into something worth reading.
 *
 * Supabase reports a password identical to the current one as `same_password`,
 * which is the one rule the client cannot check for itself — so it arrives here
 * rather than from validateNewPassword, and has to read like the rule the page
 * already stated rather than like a server error.
 */
export const describePasswordError = (err) => {
  const code = err?.code ?? "";
  const msg = (err?.message ?? "").toLowerCase();

  if (code === "same_password" || msg.includes("should be different")) {
    return "That is already your password — choose a different one.";
  }
  if (code === "weak_password" || msg.includes("password should be")) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return err?.message ?? "Could not set that password. Try again.";
};
