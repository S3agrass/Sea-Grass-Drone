import { useDrone } from "../context/DroneContext";

const STATUS_LABEL = {
  disconnected: "Disconnected",
  connecting: "Connecting…",
  connected: "Link established",
  error: "Link error",
};

export default function ConnectionPanel() {
  const {
    activeDrone,
    connect,
    disconnect,
    linkStatus,
    linkDetail,
    armed,
    flightMode,
    pixhawkOk,
    link,
    pushToast,
  } = useDrone();

  const connected = linkStatus === "connected";

  // link.arm()/disarm() return false if the socket isn't open — never let that
  // fail silently. The server's own arm/reject feedback arrives as a toast too.
  const requestArm = () => {
    if (!link.arm()) pushToast("error", "Not connected — can't send arm command");
  };
  const requestDisarm = () => {
    if (!link.disarm()) pushToast("error", "Not connected — can't send disarm command");
  };

  return (
    <section className="conn-panel" aria-labelledby="conn-panel-title">
      <div className="panel-head">
        <h2 className="eyebrow panel-title" id="conn-panel-title">Drone link</h2>
        <span className={`conn-chip ${linkStatus}`}>
          <span
            className={`ping-dot ${connected ? "live" : linkStatus === "connecting" ? "warn" : "off"}`}
            aria-hidden="true"
          />
          {STATUS_LABEL[linkStatus]}
        </span>
      </div>

      <div className="conn-host mono">{activeDrone?.host || "No link URL set"}</div>
      {linkDetail && <div className="conn-detail">{linkDetail}</div>}

      {/* A description list, not rows of anonymous spans: each value is bound
          to the term that names it, so a reader announces "Thrusters, ARMED"
          rather than two unrelated strings that happen to sit side by side.
          The transitions themselves are announced by <FlightStatus>; this is
          the static reading for anyone who navigates here to check. */}
      <dl className="conn-rows">
        <div className="conn-row">
          <dt>Pixhawk</dt>
          <dd className={`mono ${pixhawkOk ? "ok" : "dim"}`}>
            {connected ? (pixhawkOk ? "HEARTBEAT OK" : "NO HEARTBEAT") : "—"}
          </dd>
        </div>
        <div className="conn-row">
          <dt>Mode</dt>
          <dd className="mono">{connected ? flightMode : "—"}</dd>
        </div>
        <div className="conn-row">
          <dt>Thrusters</dt>
          <dd className={`mono ${armed ? "armed" : "dim"}`}>
            {connected ? (armed ? "ARMED" : "DISARMED") : "—"}
          </dd>
        </div>
      </dl>

      <div className="conn-actions">
        {connected ? (
          <button className="btn" onClick={disconnect}>Disconnect</button>
        ) : (
          <button
            className="btn btn-primary"
            onClick={connect}
            disabled={!activeDrone?.host || linkStatus === "connecting"}
          >
            {linkStatus === "connecting" ? "Connecting…" : "Connect"}
          </button>
        )}
        {connected &&
          (armed ? (
            <button className="btn btn-danger" onClick={requestDisarm}>
              Disarm
            </button>
          ) : (
            // aria-disabled rather than `disabled`, because a disabled button
            // is removed from the tab order — which means the explanation for
            // why it cannot be pressed is unreachable by exactly the person who
            // needs it. It stays focusable, announces itself as unavailable,
            // carries the reason via aria-describedby, and refuses the action
            // in the handler instead of relying on the attribute to do it.
            <>
              <button
                className="btn"
                onClick={pixhawkOk ? requestArm : undefined}
                aria-disabled={!pixhawkOk}
                aria-describedby={pixhawkOk ? undefined : "arm-blocked-reason"}
              >
                Arm thrusters
              </button>
              {!pixhawkOk && (
                <span id="arm-blocked-reason" className="conn-hint">
                  Waiting for Pixhawk heartbeat
                </span>
              )}
            </>
          ))}
      </div>
    </section>
  );
}
