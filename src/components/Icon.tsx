/** Ultra-light line icons (1.25px stroke), inline so nothing is fetched. */
const PATHS = {
  arrowRight: 'M4.5 12h15m-5.5-5.5L19.5 12 14 17.5',
  arrowLeft: 'M19.5 12h-15m5.5-5.5L4.5 12l5.5 5.5',
  arrowUpRight: 'M7 17 17 7M8.5 7H17v8.5',
  play: 'M8 5.5v13l10.5-6.5L8 5.5Z',
  plus: 'M12 5v14M5 12h14',
  close: 'M6 6l12 12M18 6 6 18',
  check: 'm5 12.5 4.5 4.5L19 7.5',
  alert: 'M12 4.5 20.5 19h-17L12 4.5ZM12 10v4m0 2.5h.01',
  upload: 'M12 15.5V4m0 0L7.5 8.5M12 4l4.5 4.5M4.5 15v3a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-3',
  download: 'M12 4v11.5m0 0 4.5-4.5M12 15.5 7.5 11M4.5 19.5h15',
  table: 'M4 5.5h16v13H4zM4 10h16M4 14.5h16M9.5 10v8.5',
  sortAsc: 'M8 18V6m0 0-3.5 3.5M8 6l3.5 3.5M14 8h6M14 12h4.5M14 16h3',
  sortDesc: 'M8 6v12m0 0-3.5-3.5M8 18l3.5-3.5M14 8h3M14 12h4.5M14 16h6',
  filter: 'M4.5 6h15l-6 7.5V19l-3-1.5v-4L4.5 6Z',
  spark: 'M12 3.5v4m0 9v4m8.5-8.5h-4m-9 0h-4m12.5-6-2.6 2.6M8.6 15.4 6 18m12 0-2.6-2.6M8.6 8.6 6 6',
  lock: 'M7 10.5V8a5 5 0 0 1 10 0v2.5M6.5 10.5h11a1 1 0 0 1 1 1v7a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1Z',
  bolt: 'M13 3.5 5.5 13.5H12L11 20.5l7.5-10H12l1-7Z',
  history: 'M4.5 12a7.5 7.5 0 1 0 2.2-5.3M4.5 4.5v3.5H8M12 8v4.5l3 1.8',
  stats: 'M5 19.5V11m5 8.5V5m5 14.5v-6m5 6V8',
  code: 'm8.5 8-4 4 4 4m7-8 4 4-4 4M13.5 5.5l-3 13',
  column: 'M9 4.5v15M15 4.5v15M4.5 4.5h15v15h-15z',
  copy: 'M8.5 8.5V6a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 19.5 6v8a1.5 1.5 0 0 1-1.5 1.5h-2.5M6 8.5h8a1.5 1.5 0 0 1 1.5 1.5v8A1.5 1.5 0 0 1 14 19.5H6A1.5 1.5 0 0 1 4.5 18v-8A1.5 1.5 0 0 1 6 8.5Z',
  bookmark: 'M7 4.5h10a1 1 0 0 1 1 1v14l-6-3.5-6 3.5v-14a1 1 0 0 1 1-1Z',
  trash: 'M5 7h14M10 4.5h4M7 7l.8 11.2A1.5 1.5 0 0 0 9.3 19.5h5.4a1.5 1.5 0 0 0 1.5-1.3L17 7M10 10.5v5.5M14 10.5v5.5',
  share: 'M8.5 12h7M15.5 7.5 19 4.5l-3.5-3M19 4.5h-5a5 5 0 0 0-5 5M6 9.5H5a1.5 1.5 0 0 0-1.5 1.5v7A1.5 1.5 0 0 0 5 19.5h11a1.5 1.5 0 0 0 1.5-1.5v-3',
  layers: 'm12 4 8.5 4.5L12 13 3.5 8.5 12 4Zm-8.5 8L12 16.5 20.5 12M3.5 15.5 12 20l8.5-4.5',
  sun: 'M12 8.25a3.75 3.75 0 1 0 0 7.5 3.75 3.75 0 0 0 0-7.5ZM12 3.5v2m0 13v2M20.5 12h-2m-13 0h-2m14.5-6-1.4 1.4M7.9 16.1 6.5 17.5m11 0-1.4-1.4M7.9 7.9 6.5 6.5',
  moon: 'M19.5 14.2A7.5 7.5 0 0 1 9.8 4.5a7.5 7.5 0 1 0 9.7 9.7Z',
  monitor: 'M4.5 5.5h15a1 1 0 0 1 1 1v9a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1ZM9 20h6M12 16.5V20',
  keyboard: 'M4 7h16a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V8a1 1 0 0 1 1-1Zm3 3.5h.01m3 0h.01m3 0h.01m3 0h.01M8 14h8',
  chevronDown: 'm6.5 9.5 5.5 5.5 5.5-5.5',
  calendar: 'M5.5 6h13a1 1 0 0 1 1 1v11.5a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1ZM4.5 10h15M8.5 4v4M15.5 4v4',
  fillDown: 'M5 4.5h14v4.5H5zM12 11.5v8m0 0-3.5-3.5m3.5 3.5 3.5-3.5',
  chevronUp: 'm6.5 14.5 5.5-5.5 5.5 5.5',
  panel: 'M4.5 5.5h15a1 1 0 0 1 1 1v11a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1ZM9.5 5.5v13M6 9h1.5M6 12h1.5',
  search: 'M10.5 17.5a7 7 0 1 0 0-14 7 7 0 0 0 0 14Zm5-2 4.5 4.5',
  compare: 'M7 4.5v15M17 4.5v15M4 8.5h6M14 15.5h6M10 8.5 8 6.5M10 8.5l-2 2M14 15.5l2-2M14 15.5l2 2',
  shield: 'M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-2.5ZM9 12l2 2 4-4',
  link: 'M10 14a3.5 3.5 0 0 0 5 0l3-3a3.5 3.5 0 0 0-5-5l-1 1M14 10a3.5 3.5 0 0 0-5 0l-3 3a3.5 3.5 0 0 0 5 5l1-1',
} as const

export type IconName = keyof typeof PATHS

export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d={PATHS[name]} />
    </svg>
  )
}

export function BtnIcon({ name = 'arrowRight' }: { name?: IconName }) {
  return (
    <span className="btn-icon">
      <Icon name={name} size={15} />
    </span>
  )
}

export function Logo({ size = 22 }: { size?: number }) {
  return (
    <svg className="logo" width={size} height={size} viewBox="0 0 24 24" fill="none" aria-hidden>
      {/* Sheets + cheetah: the sheet is the head, its tabs the ears; the tear lines are its columns, the muzzle a row */}
      <path
        d="M10.2 5.6h3.6l3.4-2.4q1.1-.7 1.3.6l.4 4.4Q21 10.2 21 13.2V15q0 6.2-6 6.2H9q-6 0-6-6.2v-1.8q0-3 2.1-5l.4-4.4q.2-1.3 1.3-.6z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <path d="M3.3 16.4h17.4" stroke="currentColor" strokeWidth="1.5" opacity="0.45" />
      <ellipse cx="8.9" cy="11.3" rx="1.3" ry="1.15" fill="currentColor" />
      <ellipse cx="15.1" cy="11.3" rx="1.3" ry="1.15" fill="currentColor" />
      <path d="M8.5 12.3c.3 2.9-.2 5.8-1.3 8.5M15.5 12.3c-.3 2.9.2 5.8 1.3 8.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M10.7 13.9h2.6L12 15.5z" fill="currentColor" stroke="currentColor" strokeWidth="0.6" strokeLinejoin="round" />
    </svg>
  )
}
