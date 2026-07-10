import { motion, type Variants } from 'motion/react';
import { getVariants, IconWrapper, useAnimateIconContext, type IconProps } from './animate-ui/icon';

export { AnimateIcon } from './animate-ui/icon';

// Hover-animated icons copied VERBATIM from animate-ui.com (the `animations`
// variant objects and SVG geometry are theirs), wired to Helm's trimmed base in
// ./animate-ui/icon.tsx instead of shadcn scaffolding. Owner approved the
// `motion` dependency for these. Exported under Icon* names so they drop in for
// the static set. See docs/ROADMAP.md and the design-language memory.

/* -------------------------------------------------------------- paperclip */
const paperclipAnim = {
  default: {
    path: {
      initial: { pathLength: 1 },
      animate: {
        pathLength: [0.02, 1],
        transition: { duration: 1.2, ease: 'easeInOut' },
      },
    },
  } satisfies Record<string, Variants>,
} as const;

function PaperclipIcon({ size, ...props }: IconProps<keyof typeof paperclipAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(paperclipAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <motion.path
        d="m16 6-8.414 8.586a2 2 0 0 0 2.829 2.829l8.414-8.586a4 4 0 1 0-5.657-5.657l-8.379 8.551a6 6 0 1 0 8.485 8.485l8.379-8.551"
        variants={variants.path}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
export const IconPaperclip = (props: IconProps<keyof typeof paperclipAnim>) => (
  <IconWrapper icon={PaperclipIcon} {...props} />
);

/* --------------------------------------------------------------- maximize */
const maximizeAnim = {
  default: {
    path1: {
      initial: { x: 0, y: 0, transition: { duration: 0.3, ease: 'easeInOut' } },
      animate: { x: -2, y: -2, transition: { duration: 0.3, ease: 'easeInOut' } },
    },
    path2: {
      initial: { y: 0, x: 0, transition: { duration: 0.3, ease: 'easeInOut' } },
      animate: { y: -2, x: 2, transition: { duration: 0.3, ease: 'easeInOut' } },
    },
    path3: {
      initial: { y: 0, x: 0, transition: { duration: 0.3, ease: 'easeInOut' } },
      animate: { y: 2, x: -2, transition: { duration: 0.3, ease: 'easeInOut' } },
    },
    path4: {
      initial: { y: 0, x: 0, transition: { duration: 0.3, ease: 'easeInOut' } },
      animate: { y: 2, x: 2, transition: { duration: 0.3, ease: 'easeInOut' } },
    },
  } satisfies Record<string, Variants>,
} as const;

function MaximizeIcon({ size, ...props }: IconProps<keyof typeof maximizeAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(maximizeAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <motion.path
        d="M8 3H5a2 2 0 0 0-2 2v3"
        variants={variants.path1}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M21 8V5a2 2 0 0 0-2-2h-3"
        variants={variants.path2}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M3 16v3a2 2 0 0 0 2 2h3"
        variants={variants.path3}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M16 21h3a2 2 0 0 0 2-2v-3"
        variants={variants.path4}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
export const IconMaximize = (props: IconProps<keyof typeof maximizeAnim>) => (
  <IconWrapper icon={MaximizeIcon} {...props} />
);

/* ----------------------------------------------------------- chart-column */
const chartAnim = {
  default: (() => {
    const animation: Record<string, Variants> = { path4: {} };
    for (let i = 1; i <= 3; i++) {
      animation[`path${i}`] = {
        initial: { opacity: 1 },
        animate: {
          opacity: [0, 1],
          pathLength: [0, 1],
          transition: { ease: 'easeInOut', duration: 0.4, delay: (i - 1) * 0.3 },
        },
      };
    }
    return animation as Record<string, Variants>;
  })() satisfies Record<string, Variants>,
} as const;

function ChartColumnIcon({ size, ...props }: IconProps<keyof typeof chartAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(chartAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <motion.path d="M8 17V13" variants={variants.path1} initial="initial" animate={controls} />
      <motion.path d="M13 17V5" variants={variants.path2} initial="initial" animate={controls} />
      <motion.path d="M18 17V9" variants={variants.path3} initial="initial" animate={controls} />
      <motion.path
        d="M3 3v16a2 2 0 0 0 2 2h16"
        variants={variants.path4}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
export const IconChart = (props: IconProps<keyof typeof chartAnim>) => (
  <IconWrapper icon={ChartColumnIcon} {...props} />
);

/* -------------------------------------------------------------------- nfc */
const nfcAnim = {
  default: (() => {
    const animation: Record<string, Variants> = {};
    for (let i = 1; i <= 4; i++) {
      animation[`path${i}`] = {
        initial: { opacity: 1, scale: 1 },
        animate: {
          opacity: 0,
          scale: 0,
          transition: {
            opacity: {
              duration: 0.2,
              ease: 'easeInOut',
              repeat: 1,
              repeatType: 'reverse',
              repeatDelay: 0.2,
              delay: 0.2 * (i - 1),
            },
            scale: {
              duration: 0.2,
              ease: 'easeInOut',
              repeat: 1,
              repeatType: 'reverse',
              repeatDelay: 0.2,
              delay: 0.2 * (i - 1),
            },
          },
        },
      };
    }
    return animation;
  })() satisfies Record<string, Variants>,
} as const;

function NfcIcon({ size, ...props }: IconProps<keyof typeof nfcAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(nfcAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <motion.path
        d="M6 8.32a7.43 7.43 0 0 1 0 7.36"
        variants={variants.path1}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M9.46 6.21a11.76 11.76 0 0 1 0 11.58"
        variants={variants.path2}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M12.91 4.1a15.91 15.91 0 0 1 .01 15.8"
        variants={variants.path3}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M16.37 2a20.16 20.16 0 0 1 0 20"
        variants={variants.path4}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
export const IconNfc = (props: IconProps<keyof typeof nfcAnim>) => (
  <IconWrapper icon={NfcIcon} {...props} />
);

/* ----------------------------------------------------------------- search */
const searchAnim = {
  default: {
    group: {
      initial: { rotate: 0 },
      animate: {
        transformOrigin: 'bottom right',
        rotate: [0, 17, -10, 5, -1, 0],
        transition: { duration: 0.8, ease: 'easeInOut' },
      },
    },
    path: {},
    circle: {},
  } satisfies Record<string, Variants>,
} as const;

function SearchIcon({ size, ...props }: IconProps<keyof typeof searchAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(searchAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      variants={variants.group}
      initial="initial"
      animate={controls}
      {...props}
    >
      <motion.path
        d="m21 21-4.34-4.34"
        variants={variants.path}
        initial="initial"
        animate={controls}
      />
      <motion.circle
        cx={11}
        cy={11}
        r={8}
        variants={variants.circle}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
export const IconSearch = (props: IconProps<keyof typeof searchAnim>) => (
  <IconWrapper icon={SearchIcon} {...props} />
);

/* ---------------------------------------------------------- chevron-down */
const chevronDownAnim = {
  default: {
    path: {
      initial: { y: 0, transition: { duration: 0.3, ease: 'easeInOut' } },
      animate: { y: 4, transition: { duration: 0.3, ease: 'easeInOut' } },
    },
  } satisfies Record<string, Variants>,
} as const;

function ChevronDownIcon({ size, ...props }: IconProps<keyof typeof chevronDownAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(chevronDownAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <motion.path d="m6 9 6 6 6-6" variants={variants.path} initial="initial" animate={controls} />
    </motion.svg>
  );
}
export const IconChevronDown = (props: IconProps<keyof typeof chevronDownAnim>) => (
  <IconWrapper icon={ChevronDownIcon} {...props} />
);

/* ------------------------------------------------------------ chevron-up */
// Mirror of animate-ui's chevron-down (bounces up instead of down).
const chevronUpAnim = {
  default: {
    path: {
      initial: { y: 0, transition: { duration: 0.3, ease: 'easeInOut' } },
      animate: { y: -4, transition: { duration: 0.3, ease: 'easeInOut' } },
    },
  } satisfies Record<string, Variants>,
} as const;

function ChevronUpIcon({ size, ...props }: IconProps<keyof typeof chevronUpAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(chevronUpAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <motion.path
        d="m18 15-6-6-6 6"
        variants={variants.path}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
export const IconChevronUp = (props: IconProps<keyof typeof chevronUpAnim>) => (
  <IconWrapper icon={ChevronUpIcon} {...props} />
);

/* ------------------------------------------------------------ refresh-ccw */
const refreshCcwAnim = {
  default: {
    group: {
      initial: { rotate: 0, transition: { type: 'spring', stiffness: 150, damping: 25 } },
      animate: { rotate: -45, transition: { type: 'spring', stiffness: 150, damping: 25 } },
    },
    path1: {},
    path2: {},
    path3: {},
    path4: {},
  } satisfies Record<string, Variants>,
} as const;

function RefreshCcwIcon({ size, ...props }: IconProps<keyof typeof refreshCcwAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(refreshCcwAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      variants={variants.group}
      initial="initial"
      animate={controls}
      {...props}
    >
      <motion.path
        d="M21 12a9 9 0 0 0-9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"
        variants={variants.path1}
        initial="initial"
        animate={controls}
      />
      <motion.path d="M3 3v5h5" variants={variants.path2} initial="initial" animate={controls} />
      <motion.path
        d="M3 12a9 9 0 0 0 9 9 9.75 9.75 0 0 0 6.74-2.74L21 16"
        variants={variants.path3}
        initial="initial"
        animate={controls}
      />
      <motion.path d="M16 16h5v5" variants={variants.path4} initial="initial" animate={controls} />
    </motion.svg>
  );
}
export const IconRefreshCcw = (props: IconProps<keyof typeof refreshCcwAnim>) => (
  <IconWrapper icon={RefreshCcwIcon} {...props} />
);

/* --------------------------------------------------------------- bell-off */
const bellOffAnim = {
  default: {
    group: {
      initial: { x: 0 },
      animate: {
        x: [0, '-7%', '7%', '-7%', '7%', 0],
        transition: { duration: 0.6, ease: 'easeInOut' },
      },
    },
    path1: {},
    path2: {},
    path3: {},
    path4: {},
  } satisfies Record<string, Variants>,
} as const;

function BellOffIcon({ size, ...props }: IconProps<keyof typeof bellOffAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(bellOffAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      variants={variants.group}
      initial="initial"
      animate={controls}
      {...props}
    >
      <motion.path
        d="M10.268 21a2 2 0 0 0 3.464 0"
        variants={variants.path1}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M17 17H4a1 1 0 0 1-.74-1.673C4.59 13.956 6 12.499 6 8a6 6 0 0 1 .258-1.742"
        variants={variants.path2}
        initial="initial"
        animate={controls}
      />
      <motion.path d="m2 2 20 20" variants={variants.path3} initial="initial" animate={controls} />
      <motion.path
        d="M8.668 3.01A6 6 0 0 1 18 8c0 2.687.77 4.653 1.707 6.05"
        variants={variants.path4}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
export const IconBellOff = (props: IconProps<keyof typeof bellOffAnim>) => (
  <IconWrapper icon={BellOffIcon} {...props} />
);

/* -------------------------------------------------------------- bell-ring */
const bellRingAnim = {
  default: {
    group: {
      initial: { rotate: 0 },
      animate: {
        rotate: [0, 20, -10, 10, -5, 3, 0],
        transformOrigin: 'top center',
        transition: { duration: 0.9, ease: 'easeInOut' },
      },
    },
    path1: {
      initial: { x: 0 },
      animate: {
        x: [0, -6, 5, -5, 4, -3, 2, 0],
        transition: { duration: 1.1, ease: 'easeInOut' },
      },
    },
    path2: {
      initial: { y: 0, scale: 1 },
      animate: {
        y: [0, 1, -0.5, 0.5, -0.25, 0],
        scale: [1, 0.8, 0.9, 1, 1],
        transition: { duration: 0.8, ease: 'easeInOut' },
      },
    },
    path3: {
      initial: { y: 0, scale: 1 },
      animate: {
        y: [0, -0.5, 1, -0.5, 0.25, 0],
        scale: [1, 0.8, 0.9, 1, 1],
        transition: { duration: 0.8, ease: 'easeInOut' },
      },
    },
    path4: {},
  } satisfies Record<string, Variants>,
} as const;

function BellRingIcon({ size, ...props }: IconProps<keyof typeof bellRingAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(bellRingAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      variants={variants.group}
      initial="initial"
      animate={controls}
      {...props}
    >
      <motion.path
        d="M10.268 21a2 2 0 0 0 3.464 0"
        variants={variants.path1}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M22 8c0-2.3-.8-4.3-2-6"
        variants={variants.path2}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M4 2C2.8 3.7 2 5.7 2 8"
        variants={variants.path3}
        initial="initial"
        animate={controls}
      />
      <motion.path
        d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"
        variants={variants.path4}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
export const IconBellRing = (props: IconProps<keyof typeof bellRingAnim>) => (
  <IconWrapper icon={BellRingIcon} {...props} />
);

/* --------------------------------------------------------------- terminal */
const terminalAnim = {
  default: {
    polyline: {
      initial: { x: 0 },
      animate: {
        x: [0, 3, 0],
        transition: { duration: 0.5, ease: 'easeInOut' },
      },
    },
    line: {},
  } satisfies Record<string, Variants>,
} as const;

function TerminalIcon({ size, ...props }: IconProps<keyof typeof terminalAnim>) {
  const { controls } = useAnimateIconContext();
  const variants = getVariants(terminalAnim);
  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <motion.polyline
        points="4 17 10 11 4 5"
        variants={variants.polyline}
        initial="initial"
        animate={controls}
      />
      <motion.line
        x1={12}
        x2={20}
        y1={19}
        y2={19}
        variants={variants.line}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}
export const IconTerminal = (props: IconProps<keyof typeof terminalAnim>) => (
  <IconWrapper icon={TerminalIcon} {...props} />
);
