import { useEffect, useState } from 'react';
import { clockString } from '../state/reducer';

export function useClock(): string {
  const [text, setText] = useState(() => clockString(new Date()));
  useEffect(() => {
    const id = setInterval(() => setText(clockString(new Date())), 1000);
    return () => clearInterval(id);
  }, []);
  return text;
}
