import { useEffect, useState } from 'react';

/** The current time, refreshed every `ms`, so "3 min ago" stays true without a refetch. */
export function useNow(ms = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}
