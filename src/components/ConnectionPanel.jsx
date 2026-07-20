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
    <div className="conn-panel">
      <div className="panel-head">
        <span className="eyebrow">Drone link</span>
        <span className={`conn-chip ${linkStatus}`}>
          <span className={`ping-dot ${connected ? "live" : linkStatus === "connecting" ? "warn" : "off"}`} />
          {STATUS_LABEL[linkStatus]}
        </span>
      </div>

      <div className="conn-host mono">{activeDrone?.host || "No link URL set"}</div>
      {linkDetail && <div className="conn-detail">{linkDetail}</div>}

      <div className="conn-rows">
        <div className="conn-row">
          <span>Pixhawk</span>
          <span className={`mono ${pixhawkOk ? "ok" : "dim"}`}>
            {connected ? (pixhawkOk ? "HEARTBEAT OK" : "NO HEARTBEAT") : "—"}
          </span>
        </div>
        <div className="conn-row">
          <span>Mode</span>
          <span className="mono">{connected ? flightMode : "—"}</span>
        </div>
        <div className="conn-row">
          <span>Thrusters</span>
          <span className={`mono ${armed ? "armed" : "dim"}`}>
            {connected ? (armed ? "ARMED" : "DISARMED") : "—"}
          </span>
        </div>
      </div>

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
            <button
              className="btn"
              onClick={requestArm}
              disabled={!pixhawkOk}
              title={pixhawkOk ? "" : "Waiting for Pixhawk heartbeat"}
            >
              Arm thrusters
            </button>
          ))}
      </div>
    </div>
  );
}
