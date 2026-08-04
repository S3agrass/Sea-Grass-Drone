import { useDrone } from "../context/DroneContext";

// Field operator alerts — arm rejections, PreArm reasons, link errors. These
// used to be silently dropped; surfacing them here is what makes a failed arm
// attempt visible in the UI instead of the vehicle just staying DISARMED.
export default function Toasts() {
  const { toasts, dismissToast } = useDrone();

  // Two stacks rather than one. Everything went through a single polite region,
  // which meant an arm rejection — the operator pressed Arm and the vehicle
  // refused — waited its turn behind whatever was being read and could be
  // several seconds late or dropped entirely. Errors are the reason this
  // component exists, so they get the interrupting channel and the rest stay
  // polite. Both stacks are always mounted: a live region has to exist before
  // its content arrives to be announced reliably.
  const errors = toasts.filter((t) => t.level === "error");
  const rest = toasts.filter((t) => t.level !== "error");

  const item = (t) => (
    <div key={t.id} className={`toast toast-${t.level}`}>
      <span className="toast-msg">{t.message}</span>
      <button
        className="toast-close"
        onClick={() => dismissToast(t.id)}
        // Names which toast this dismisses — a stack of four identical
        // "Dismiss" buttons is unusable out of visual context.
        aria-label={`Dismiss: ${t.message}`}
      >
        <span aria-hidden="true">×</span>
      </button>
    </div>
  );

  // One positioned stack holding both regions, so they share the corner and
  // read top-to-bottom with errors first, rather than two fixed containers
  // painting over each other.
  return (
    <div className="toast-stack">
      <div className="toast-region" role="alert" aria-live="assertive">
        {errors.map(item)}
      </div>
      <div className="toast-region" role="status" aria-live="polite">
        {rest.map(item)}
      </div>
    </div>
  );
}
