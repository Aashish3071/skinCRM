import { AutomationTabs } from "./tabs";

export default function AutomationsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <AutomationTabs />
      {children}
    </>
  );
}
