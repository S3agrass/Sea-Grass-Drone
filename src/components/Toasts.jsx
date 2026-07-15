import { useDrone } from "../context/DroneContext";

// Field operator alerts — arm rejections, PreArm reasons, link errors. These
// used to be silently dropped; surfacing them here is what makes a failed arm
// attempt visible in the UI instead of the vehicle just staying DISARMED.
export default function Toasts() {
  const { toasts, dismissToast } = useDrone();
  if (!toasts.length) return null;

  return (
    <div className="toast-stack" role="status" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={`toast toast-${t.level}`}>
          <span className="toast-msg">{t.message}</span>
          <button
            className="toast-close"
            onClick={() => dismissToast(t.id)}
            aria-label="Dismiss"
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
