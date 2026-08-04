// What went wrong when an account-recovery email could not be sent.
//
// Lifted out of LoginPage when the forgot-password flow moved to its own page.
// Both still send mail through Supabase and both hit the same four failures, and
// the rate-limit wording in particular is worth keeping identical: the two limits
// below look the same to a user and need completely different responses, and
// getting that distinction right once is better than getting it right twice.

/** Returns the message to show for a failed recovery send. */
export const describeRecoveryError = (err) => {
  const code = err?.code ?? "";
  const msg = (err?.message ?? "").toLowerCase();

  if (code === "over_email_send_rate_limit" || msg.includes("email rate limit")) {
    // The hourly project quota, not a per-user cooldown. Waiting "a minute" —
    // which this used to say — does nothing.
    return "This project's email limit is used up — it can only send a few messages an hour. Wait about an hour, or ask an administrator to configure SMTP.";
  }
  if (
    code === "over_request_rate_limit" ||
    msg.includes("rate limit") ||
    msg.includes("security purposes")
  ) {
    // This one IS short — Supabase enforces a brief gap between repeat sends to
    // the same address.
    return "Just sent one. Wait a minute before requesting another.";
  }
  if (code === "validation_failed" || msg.includes("invalid email")) {
    return "Please enter a valid email address.";
  }
  return err?.message ?? "Could not send the email. Try again.";
};
