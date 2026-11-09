import { useEffect, useState } from 'react';
import { today } from './calc';

/** Civil day that refreshes on visibility return and while the screen stays open. */
let daySource: () => string = today;
export function setDaySourceForTest(source: (() => string) | null) {
  daySource = source ?? today;
}
export function useToday(): string {
  const [day, setDay] = useState(() => daySource());
  useEffect(() => {
    const tick = () => setDay((current) => (current === daySource() ? current : daySource()));
    const timer = setInterval(tick, 60_000);
    const visible = () => {
      if (document.visibilityState === 'visible') tick();
    };
    document.addEventListener('visibilitychange', visible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', visible);
    };
  }, []);
  return day;
}
