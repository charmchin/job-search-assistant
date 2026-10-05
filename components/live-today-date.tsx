'use client';

import { useEffect, useState } from 'react';
import { todayText } from '@/components/workspace-common';

export function LiveTodayDate() {
  // Identical first paint on server/client, even at midnight or after clock changes.
  const [value, setValue] = useState('上海时间');
  useEffect(() => {
    const tick = () => setValue(todayText());
    const frame = requestAnimationFrame(tick);
    const timer = setInterval(tick, 30_000);
    window.addEventListener('focus', tick);
    return () => {
      cancelAnimationFrame(frame);
      clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, []);
  return value;
}
