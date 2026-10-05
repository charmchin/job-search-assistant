'use client';
import { useRef, useState } from 'react';

export function useSaveAction() {
  const lock = useRef(false);
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState('');
  const [failed, setFailed] = useState(false);
  const run = async (operation: () => Promise<unknown>) => {
    if (lock.current) return;
    lock.current = true;
    setPending(true);
    setMessage('');
    setFailed(false);
    try {
      const result = await operation();
      setMessage(
        result &&
          typeof result === 'object' &&
          'refreshFailed' in result &&
          result.refreshFailed
          ? '已保存，但列表尚未更新。请关闭详情并点击页面的“重试刷新”，不要再次提交。'
          : '已保存。',
      );
    } catch (error) {
      setFailed(true);
      setMessage(
        error instanceof Error
          ? error.message
          : '保存失败，输入已保留，请重试。',
      );
    } finally {
      lock.current = false;
      setPending(false);
    }
  };
  const reset = () => {
    if (!lock.current) {
      setMessage('');
      setFailed(false);
    }
  };
  return { pending, message, failed, run, reset };
}
