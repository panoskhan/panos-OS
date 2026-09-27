const OUTER_AGENTS = ["Planner", "Model Router", "Permissions"];
const INNER_AGENTS = ["QA", "Files", "Coding"];

/** Decorative orbital animation, pure CSS. Carries no data — it never depends on task state. */
export function OrbitalCanvas() {
  return (
    <div className="orbital-wrap" aria-hidden="true">
      <div className="orbital">
        <div className="orbit-ring" data-ring="outer">
          {OUTER_AGENTS.map((name, index) => (
            <div className="planet-slot" style={{ transform: `rotate(${index * 120}deg)` }} key={name}>
              <div className="planet">
                <span className="planet-dot" />
                <span className="planet-label">{name}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="orbit-ring" data-ring="inner">
          {INNER_AGENTS.map((name, index) => (
            <div className="planet-slot" style={{ transform: `rotate(${index * 120 + 60}deg)` }} key={name}>
              <div className="planet">
                <span className="planet-dot" />
                <span className="planet-label">{name}</span>
              </div>
            </div>
          ))}
        </div>
        <div className="orbit-core">
          <b>KHAN OS</b>
        </div>
      </div>
    </div>
  );
}
