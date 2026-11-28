const paths = {
  grid: "M3.5 3.5h7v7h-7zM13.5 3.5h7v7h-7zM3.5 13.5h7v7h-7zM13.5 13.5h7v7h-7z",
  layers: "m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5",
  connect: "M9 15l6-6M8 17H7a4 4 0 0 1 0-8h3M16 7h1a4 4 0 0 1 0 8h-3",
  receipt: "M6 3h12v18l-3-2-3 2-3-2-3 2V3ZM9 8h6m-6 4h6",
  support: "M20 11.5a8 8 0 0 1-8.5 8H4l1.6-3.6A8 8 0 1 1 20 11.5Z",
  key: "M14 9a5 5 0 1 1 8 4 5 5 0 0 1-6 1l-6 6H6v-4l7-7ZM19 8h.01",
  menu: "M4 6h16M4 12h16M4 18h16",
  close: "m6 6 12 12M18 6 6 18",
  out: "M10 5H5v14h5M9 12h12m-4-4 4 4-4 4",
  arrow: "M5 12h14m-5-5 5 5-5 5",
  back: "M19 12H5m5 5-5-5 5-5",
  users: "M16 20v-2a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-4M13.5 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0ZM17 3a4 4 0 0 1 0 8",
  pulse: "M2 12h5l3-7 4 14 3-7h5",
  terminal: "M3 4h18v16H3zM7 9l3 3-3 3m6 0h4",
  lock: "M6 10h12v10H6zM8 10V7a4 4 0 0 1 8 0v3m-4 4v2",
  warning: "M12 3 2.5 20h19L12 3Zm0 6v4m0 3h.01",
  check: "m5 12 4 4L19 6",
  copy: "M8 8h12v12H8zM16 4H4v12",
  clock: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-9-5v5l3 2",
  money: "M3 6h18v12H3zM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0ZM6 12h.01M18 12h.01",
  mail: "M3 5h18v14H3zM3 6l9 7 9-7",
  eye: "M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  eyeOff: "m3 3 18 18M10.1 6.2c.6-.1 1.25-.2 1.9-.2 6.5 0 10 6 10 6a15 15 0 0 1-2.8 3.2M6.6 7.8A16 16 0 0 0 2 12s3.5 6 10 6c1.4 0 2.7-.3 3.9-.8",
  search: "M15.5 10a5.5 5.5 0 1 1-11 0 5.5 5.5 0 0 1 11 0ZM14 14l5.5 5.5",
  bell: "M5 17h14l-2-3V9a5 5 0 0 0-10 0v5l-2 3Zm5 3h4",
  qr: "M3.5 3.5h6v6h-6zM14.5 3.5h6v6h-6zM3.5 14.5h6v6h-6zM14.5 14.5h3v3h3v3m-6 0h.01m6-6h.01",
  phone: "M7 3h10v18H7zM11 18h2",
  help: "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Zm-11.5-2.6a2.5 2.5 0 1 1 4.2 1.8c-1 .9-1.7 1.2-1.7 2.3v.4m0 2.8h.01",
  monitor: "M3 4.5h18v12H3zM12 16.5v3m-4 0h8",
  tv: "M3 5h18v13H3zM5 20h14m-2-4h2",
  laptop: "M5 5h14v11H5zM5 16l-2 3h18l-2-3",
  more: "M5 12h.01M12 12h.01M19 12h.01",
} as const;

export type IconName = keyof typeof paths;
export function Icon({ name, size = 20 }: { name: IconName; size?: number }) {
  return <svg aria-hidden="true" focusable="false" width={size} height={size} viewBox="0 0 24 24"
    fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinejoin="round" strokeLinecap="round">
    <path d={paths[name]} />
  </svg>;
}

export function Labyrinth({ className }: { className?: string }) {
  return <svg className={className} aria-hidden="true" focusable="false" viewBox="0 0 600 460" fill="none">
    <path className="mz-maze-area" d="M25 59h224v32h-64v96H90v96h128v96H57v-64H25Zm320 64h224v64H441v64h64v96h-32v64H345V283h-32v-96h32Z" />
    <path className="mz-maze-datum" d="M9 27h576M9 427h576M25 11v432M569 11v432M281 27v400M25 219h544" />
    <path className="mz-maze-walls" d="M25 155V59h224V27m0 32h96v64h96V59h128v128H441v64h64v96h64v64H345V283h-32v-96h64v-32h64m-416 64v96h32v96h160v-32h64V251h-64v-64h-32V91h96v64h32v-64h96V59m-352 64V91h96v64H89v96h96v64h64m-192-96v64h96v64h-64v32h96m192-128v96h32v32h96m-64-96v64h32m64-128v96h32m-96-96h96m-96-96h64m-288 160h64m-64 96v64m-32-224h-64m192 128v64h-32m-256-96v32m160-288h32m256 256v32" />
    <path className="mz-maze-route" d="M9 187h112v-64h64v96h64v64h64v64h96v-64h-32v-64h64v-64h96v-32h48" />
    <circle className="mz-maze-end" cx="9" cy="187" r="4" />
    <circle className="mz-maze-end" cx="585" cy="123" r="4" />
    <path className="mz-maze-marks" d="M9 27h7m-7 0v7m569-7h7m0 0v7M9 420v7m0 0h7m569-7v7m-7 0h7M277 27h8m-4-4v8M565 427h8m-4-4v8" />
  </svg>;
}
