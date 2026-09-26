import type { SVGProps } from "react";

/**
 * A small inline icon set (24px grid, 1.75 stroke), so the app carries no icon
 * dependency. Icons are decorative by default — `aria-hidden` — because every
 * one sits next to a text label; a bare icon button must pass `aria-label` on
 * the button itself.
 */
type IconProps = SVGProps<SVGSVGElement> & { size?: number };

function Svg({ size = 18, children, ...rest }: IconProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const HomeIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V21h14V9.5" /></Svg>
);
export const LeadsIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 5h18l-7 8v6l-4 2v-8Z" /></Svg>
);
export const PeopleIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5" /><path d="M16 4.8a3.5 3.5 0 0 1 0 6.4M18.5 14.8c1.6.8 2.6 2.6 3 5.2" /></Svg>
);
export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="4.5" width="18" height="16.5" rx="2.5" /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" /></Svg>
);
export const ZapIcon = (p: IconProps) => (
  <Svg {...p}><path d="M13 2 4 14h7l-1 8 9-12h-7Z" /></Svg>
);
export const SettingsIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></Svg>
);
export const PlusIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14M5 12h14" /></Svg>
);
export const SearchIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></Svg>
);
export const MailIcon = (p: IconProps) => (
  <Svg {...p}><rect x="3" y="5" width="18" height="14" rx="2.5" /><path d="m3.5 6.5 8.5 6.5 8.5-6.5" /></Svg>
);
export const ChatIcon = (p: IconProps) => (
  <Svg {...p}><path d="M20.5 11.5a8.5 8.5 0 0 1-12.4 7.6L3 20.5l1.4-4.7A8.5 8.5 0 1 1 20.5 11.5Z" /></Svg>
);
export const ClockIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></Svg>
);
export const FilterIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 6h16M7 12h10M10 18h4" /></Svg>
);
export const TaskIcon = (p: IconProps) => (
  <Svg {...p}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="m8.5 12 2.5 2.5 4.5-5" /></Svg>
);
export const FlagIcon = (p: IconProps) => (
  <Svg {...p}><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></Svg>
);
export const TrashIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 7h16M9 7V4.5h6V7M6.5 7l1 13h9l1-13" /></Svg>
);
export const ArrowUpIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 19V5M6 11l6-6 6 6" /></Svg>
);
export const ArrowDownIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 5v14M6 13l6 6 6-6" /></Svg>
);
export const XIcon = (p: IconProps) => (
  <Svg {...p}><path d="M6 6l12 12M18 6 6 18" /></Svg>
);
export const PlayIcon = (p: IconProps) => (
  <Svg {...p}><path d="M7 4.5v15l12-7.5Z" /></Svg>
);
export const PauseIcon = (p: IconProps) => (
  <Svg {...p}><path d="M8 5v14M16 5v14" /></Svg>
);
export const LogoutIcon = (p: IconProps) => (
  <Svg {...p}><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3M10 17l5-5-5-5M15 12H3" /></Svg>
);
export const PhoneIcon = (p: IconProps) => (
  <Svg {...p}><path d="M5 3.5h3.5l1.5 4.5-2.2 1.4a11 11 0 0 0 6.8 6.8l1.4-2.2 4.5 1.5V19a2 2 0 0 1-2 2A16.5 16.5 0 0 1 3 5.5a2 2 0 0 1 2-2Z" /></Svg>
);
export const ChevronRightIcon = (p: IconProps) => (
  <Svg {...p}><path d="m9 6 6 6-6 6" /></Svg>
);
export const SparkIcon = (p: IconProps) => (
  <Svg {...p}><path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8" /></Svg>
);
export const NotesIcon = (p: IconProps) => (
  <Svg {...p}><path d="M6 3h9l4 4v14H6Z" /><path d="M14 3v5h5M9 13h7M9 17h5" /></Svg>
);
export const ActivityIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 12h4l3-8 4 16 3-8h4" /></Svg>
);
export const InboxIcon = (p: IconProps) => (
  <Svg {...p}><path d="M3 13h5l1.5 3h5L16 13h5" /><path d="M5 5h14l2 8v6H3v-6Z" /></Svg>
);
export const MoreIcon = (p: IconProps) => (
  <Svg {...p}><circle cx="5" cy="12" r="1.3" /><circle cx="12" cy="12" r="1.3" /><circle cx="19" cy="12" r="1.3" /></Svg>
);
export const SendIcon = (p: IconProps) => (
  <Svg {...p}><path d="M21 3 10 14M21 3l-7 18-4-7-7-4Z" /></Svg>
);
export const LockIcon = (p: IconProps) => (
  <Svg {...p}><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V7a4 4 0 0 1 8 0v4" /></Svg>
);
export const ChevronLeftIcon = (p: IconProps) => (
  <Svg {...p}><path d="m15 6-6 6 6 6" /></Svg>
);
export const ReportsIcon = (p: IconProps) => (
  <Svg {...p}><path d="M4 20V10M10 20V4M16 20v-7M22 20H2" /></Svg>
);
