import { useId, type CSSProperties } from "react";
import { mazeRings, mazeSpokes } from "./assets/maze-v5";

export const mazeOpeningMs = 740;
const ringOffsets = [-22, 24, -18, 34, -24, 24, -30, 17];
const route = "M973 500H500";

export function LabyrinthBackground({ scene = "edge" }: { scene?: "login" | "edge" | "admin" }) {
  return <OrbitMaze className={`mz-labyrinth mz-labyrinth--${scene}`} />;
}

export function MazeOpening() {
  return <div className="mz-maze-opening" role="status" aria-label="Открываем кабинет">
    <OrbitMaze className="mz-maze-opening__maze" opening />
  </div>;
}

function OrbitMaze({ className, opening = false }: { className: string; opening?: boolean }) {
  const gradientId = useId();
  return <svg className={className} viewBox="0 0 1000 1000" aria-hidden="true" focusable="false" fill="none">
    <defs>
      <linearGradient id={gradientId} x2=".8" y2="1">
        <stop stopColor="#715096" />
        <stop offset=".48" stopColor="#30203f" />
        <stop offset="1" stopColor="#69458e" />
      </linearGradient>
    </defs>
    <g stroke={`url(#${gradientId})`} strokeWidth="17" strokeLinecap="round">
      {mazeRings.map((path, index) =>
        <path key={path} d={path} className="mz-orbit-ring"
          style={{ "--mz-ring-offset": `${ringOffsets[index]}deg` } as CSSProperties} />)}
      <path d={mazeSpokes} className="mz-orbit-spokes" />
    </g>
    {opening && <g className="mz-orbit-light">
      <path d={route} pathLength="100" className="mz-orbit-trail" />
      <circle r="8" opacity="0" fill="#f2e5ff">
        <animateMotion path={route} begin="250ms" dur="390ms" fill="freeze" />
        <animate attributeName="opacity" values="0;1;1;0" keyTimes="0;.1;.8;1" begin="250ms" dur="430ms" />
      </circle>
      <circle cx="500" cy="500" className="mz-orbit-center" r="11" />
    </g>}
  </svg>;
}
