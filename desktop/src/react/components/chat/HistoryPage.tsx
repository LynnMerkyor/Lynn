import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react';

/** Keep measured space, but unmount expensive off-screen Markdown/tool trees. */
export function HistoryPage({ root, count, initialVisible, children }: {
  root: RefObject<HTMLDivElement | null>; count: number; initialVisible: boolean; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const height = useRef(count * 160);
  const compensateAbove = useRef(false);
  const [visible, setVisible] = useState(initialVisible);
  useEffect(() => {
    const element = ref.current;
    if (!element || typeof IntersectionObserver === 'undefined') { setVisible(true); return; }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting && element.contains(document.activeElement)) return;
      compensateAbove.current = Boolean(entry.isIntersecting && root.current && element.getBoundingClientRect().bottom <= root.current.getBoundingClientRect().top);
      setVisible(entry.isIntersecting);
    }, { root: root.current, rootMargin: '1200px 0px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [root]);
  useLayoutEffect(() => {
    if (!visible || !ref.current) return;
    const measure = () => {
      if (!ref.current) return;
      const measured = ref.current.getBoundingClientRect().height;
      if (compensateAbove.current && root.current) root.current.scrollTop += measured - height.current;
      compensateAbove.current = false;
      height.current = measured;
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(ref.current);
    return () => observer.disconnect();
  }, [visible, children]);
  return <div ref={ref} data-history-page="" style={visible ? undefined : { height: height.current }}>
    {visible ? children : null}
  </div>;
}
