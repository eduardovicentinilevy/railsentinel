import type { ReactNode } from 'react';

const PATHS = {
  overview: (
    <>
      <rect x="4" y="4" width="7" height="7" rx="1.5" />
      <rect x="13" y="4" width="7" height="4.5" rx="1.5" />
      <rect x="13" y="11" width="7" height="9" rx="1.5" />
      <rect x="4" y="13.5" width="7" height="6.5" rx="1.5" />
    </>
  ),
  line: (
    <>
      <path d="M3 14h18" />
      <circle cx="6.5" cy="14" r="1.8" />
      <circle cx="17.5" cy="14" r="1.8" />
      <rect x="9" y="5.5" width="6" height="5" rx="1.5" />
      <path d="M12 10.5V14" />
    </>
  ),
  alarm: (
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2.2 2.2 0 0 0 4 0" />
    </>
  ),
  signal: (
    <>
      <rect x="8" y="3" width="8" height="15" rx="3" />
      <circle cx="12" cy="7.2" r="1.3" />
      <circle cx="12" cy="10.5" r="1.3" />
      <circle cx="12" cy="13.8" r="1.3" />
      <path d="M12 18v3" />
    </>
  ),
  camera: (
    <>
      <rect x="3" y="7" width="12.5" height="10" rx="2" />
      <path d="M15.5 11l5-3v8l-5-3" />
    </>
  ),
  log: (
    <>
      <path d="M9 6.5h11M9 12h11M9 17.5h11" />
      <circle cx="5" cy="6.5" r="1" />
      <circle cx="5" cy="12" r="1" />
      <circle cx="5" cy="17.5" r="1" />
    </>
  ),
  handover: (
    <>
      <path d="M4 8.5h14.5M15.5 5l3.5 3.5-3.5 3.5" />
      <path d="M20 15.5H5.5M8.5 12L5 15.5 8.5 19" />
    </>
  ),
  search: (
    <>
      <circle cx="11" cy="11" r="6" />
      <path d="M15.5 15.5L20 20" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4L7 17M17 7l1.4-1.4" />
    </>
  ),
  moon: <path d="M19.5 14.5A7.8 7.8 0 1 1 9.5 4.5a6.2 6.2 0 0 0 10 10z" />,
  contrast: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none" />
    </>
  ),
  radio: (
    <>
      <rect x="5" y="8" width="14" height="12.5" rx="2" />
      <path d="M8.5 8L16 3.5" />
      <circle cx="12" cy="14.2" r="2.6" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  shield: <path d="M12 3l7 3v5.2c0 4.6-3 8.1-7 9.8-4-1.7-7-5.2-7-9.8V6z" />,
  user: (
    <>
      <circle cx="12" cy="8.5" r="3.5" />
      <path d="M5 19.5c1.2-3.3 3.8-5 7-5s5.8 1.7 7 5" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7.5" />,
  close: <path d="M6.5 6.5l11 11M17.5 6.5l-11 11" />,
  chevronLeft: <path d="M14.5 6l-6 6 6 6" />,
  chevronRight: <path d="M9.5 6l6 6-6 6" />,
  arrowRight: <path d="M5 12h13M13 7l5 5-5 5" />,
  logout: (
    <>
      <path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" />
      <path d="M10 16l-4-4 4-4M6 12h9.5" />
    </>
  ),
  copy: (
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="2" />
      <path d="M15.5 8.5V6.5a2 2 0 0 0-2-2h-7a2 2 0 0 0-2 2v7a2 2 0 0 0 2 2h2" />
    </>
  ),
} satisfies Record<string, ReactNode>;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {PATHS[name]}
    </svg>
  );
}
