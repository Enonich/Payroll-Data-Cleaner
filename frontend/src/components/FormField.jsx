import { useId, useLayoutEffect, useRef, useState } from 'react';
import { HelpCircle } from 'lucide-react';

function getTooltipPosition(rect, placement) {
  const gap = 8;
  const tooltipWidth = 224; // w-56 = 14rem = 224px
  const tooltipHeight = 40; // approximate, you can measure dynamically

  // Default top position
  let top = rect.top + rect.height / 2;
  let left = rect.left - gap;
  let transform = 'translate(-100%, -50%)';

  // If placement is 'left' but not enough space on the left, fallback to 'right'
  if (placement === 'left' && rect.left - gap < tooltipWidth) {
    left = rect.right + gap;
    transform = 'translateY(-50%)';
  }

  // If placement is 'right' but not enough space on the right, fallback to 'left'
  if (placement === 'right' && window.innerWidth - rect.right - gap < tooltipWidth) {
    left = rect.left - gap;
    transform = 'translate(-100%, -50%)';
  }

  return { top, left, transform };
}

export function FieldTooltip({ label, text, placement = 'top' }) {
  const tooltipId = useId();
  const triggerRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [style, setStyle] = useState(null);

  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return undefined;

    const updatePosition = () => {
      if (!triggerRef.current) return;
      setStyle(getTooltipPosition(triggerRef.current.getBoundingClientRect(), placement));
    };

    updatePosition();
    window.addEventListener('scroll', updatePosition, true);
    window.addEventListener('resize', updatePosition);

    return () => {
      window.removeEventListener('scroll', updatePosition, true);
      window.removeEventListener('resize', updatePosition);
    };
  }, [open, placement]);

  if (!text) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-describedby={open ? tooltipId : undefined}
        aria-label={`More information about ${label}`}
        className="inline-flex shrink-0 rounded-full p-0.5 text-slate-400 transition-colors hover:text-slate-700 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
      >
        <HelpCircle className="h-3.5 w-3.5" />
      </button>
      {open && style && (
        <span
          id={tooltipId}
          role="tooltip"
          className="pointer-events-none fixed z-[100] w-56 rounded-md bg-slate-900 px-2.5 py-2 text-[11px] leading-4 text-white shadow-lg"
          style={style}
        >
          {text}
        </span>
      )}
    </>
  );
}

export default function FormField({
  label,
  tooltip,
  children,
  className = '',
  labelClassName = '',
  tooltipPlacement = 'top',
}) {
  return (
    <div className={`space-y-1.5 ${className}`}>
      <div className={`flex items-center gap-1.5 ${labelClassName}`}>
        <span className="text-xs font-medium text-slate-800">{label}</span>
        <FieldTooltip label={label} text={tooltip} placement={tooltipPlacement} />
      </div>
      {children}
    </div>
  );
}
