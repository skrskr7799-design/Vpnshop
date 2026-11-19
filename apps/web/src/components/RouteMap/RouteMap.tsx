import "./RouteMap.css";

// Хаб и пять узлов: одна подписка, несколько устройств.
const HUB = { x: 200, y: 200 };
const NODES = [
  { x: 64, y: 96 },
  { x: 318, y: 58 },
  { x: 344, y: 236 },
  { x: 196, y: 352 },
  { x: 58, y: 286 },
];

export function RouteMap() {
  return (
    <svg className="route-map" viewBox="0 0 400 400" role="img" aria-label="Пять устройств подключены к одной подписке">
      <circle className="route-map__ring" cx={HUB.x} cy={HUB.y} r="150" />
      {NODES.map((node, i) => (
        <path
          key={`line-${i}`}
          className="route-map__line"
          style={{ "--i": i } as React.CSSProperties}
          d={`M${HUB.x} ${HUB.y} L${node.x} ${node.y}`}
          pathLength="1"
        />
      ))}
      {NODES.map((node, i) => (
        <circle
          key={`node-${i}`}
          className="route-map__node"
          style={{ "--i": i } as React.CSSProperties}
          cx={node.x}
          cy={node.y}
          r="5"
        />
      ))}
      <circle className="route-map__halo" cx={HUB.x} cy={HUB.y} r="20" />
      <circle className="route-map__hub" cx={HUB.x} cy={HUB.y} r="9" />
    </svg>
  );
}
