import * as React from 'react';
import {
  motion,
  useAnimation,
  type LegacyAnimationControls,
  type SVGMotionProps,
  type Variants,
} from 'motion/react';

// Trimmed port of animate-ui's icon infrastructure
// (@/components/animate-ui/icons/icon). Keeps exactly what Helm's ported icons
// need — a shared AnimationControls exposed via context so each icon's own
// `animations` variants play on hover/tap — and drops the parts we don't use
// (in-view triggers, loop machinery, cn, static path presets).
// The icon components in AnimatedIcons.tsx are copied verbatim from animate-ui
// and depend on the API exported here: IconWrapper, useAnimateIconContext,
// getVariants, IconProps. AnimateIcon lets a whole button drive the animation.

type AnimateIconContextValue = {
  controls: LegacyAnimationControls | undefined;
  animation: string;
};

const AnimateIconContext = React.createContext<AnimateIconContextValue | null>(null);

export function useAnimateIconContext(): AnimateIconContextValue {
  return React.useContext(AnimateIconContext) ?? { controls: undefined, animation: 'default' };
}

export type IconProps<T extends string = string> = Omit<
  SVGMotionProps<SVGSVGElement>,
  'animate'
> & {
  size?: number;
  animation?: T;
  animateOnHover?: boolean;
  animateOnTap?: boolean;
};

type IconWrapperProps<T extends string> = IconProps<T> & {
  icon: React.ComponentType<IconProps<T>>;
};

// Selects the variant set for the active animation name (falls back to default).
export function getVariants<T extends Record<string, Record<string, Variants>>>(
  animations: T,
): Record<string, Variants> {
  const { animation } = useAnimateIconContext();
  return animations[animation] ?? animations.default;
}

// Runs the caller's handler first, then ours — so we don't clobber a button's
// existing onMouseEnter/onClick etc. when cloning.
function compose<E>(theirs?: (e: E) => void, ours?: (e: E) => void) {
  return (e: E) => {
    theirs?.(e);
    ours?.(e);
  };
}

function useHoverControls(animateOnHover: boolean, animateOnTap: boolean) {
  const controls = useAnimation();
  const play = () => void controls.start('animate');
  const reset = () => void controls.start('initial');
  const handlers = {
    onMouseEnter: animateOnHover ? play : undefined,
    onMouseLeave: animateOnHover || animateOnTap ? reset : undefined,
    onPointerDown: animateOnTap ? play : undefined,
    onPointerUp: animateOnTap ? reset : undefined,
  };
  return { controls, handlers };
}

// Wrap a hover target (usually a <button>) so hovering ANYWHERE on it plays the
// icon animation. `asChild` clones the single child element and attaches the
// hover handlers to it (merging with any it already has); otherwise a <span> is
// rendered. The icon inside reads the shared controls via context.
export function AnimateIcon({
  animation = 'default',
  animateOnHover = true,
  animateOnTap = false,
  asChild = false,
  children,
}: {
  animation?: string;
  animateOnHover?: boolean;
  animateOnTap?: boolean;
  asChild?: boolean;
  children: React.ReactNode;
}) {
  const { controls, handlers } = useHoverControls(animateOnHover, animateOnTap);

  let content: React.ReactNode;
  if (asChild && React.isValidElement(children)) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const childProps = children.props as any;
    content = React.cloneElement(
      children as React.ReactElement,
      {
        onMouseEnter: compose(childProps.onMouseEnter, handlers.onMouseEnter),
        onMouseLeave: compose(childProps.onMouseLeave, handlers.onMouseLeave),
        onPointerDown: compose(childProps.onPointerDown, handlers.onPointerDown),
        onPointerUp: compose(childProps.onPointerUp, handlers.onPointerUp),
      } as React.HTMLAttributes<HTMLElement>,
    );
  } else {
    content = (
      <motion.span style={{ display: 'inline-flex', lineHeight: 0 }} {...handlers}>
        {children}
      </motion.span>
    );
  }

  return (
    <AnimateIconContext.Provider value={{ controls, animation }}>
      {content}
    </AnimateIconContext.Provider>
  );
}

// Renders an animate-ui icon. If a parent <AnimateIcon> is present (e.g. the
// button is wrapped), the icon uses that shared controls so the whole button
// drives it. Otherwise it self-triggers on its own hover.
export function IconWrapper<T extends string>({
  size = 15,
  animation = 'default' as T,
  animateOnHover = true,
  animateOnTap = false,
  icon: Icon,
  ...props
}: IconWrapperProps<T>) {
  const parent = React.useContext(AnimateIconContext);
  // Own controls only used when no parent AnimateIcon is driving us. The hook
  // must run unconditionally, so it's always created but only wired up below.
  const { controls, handlers } = useHoverControls(animateOnHover, animateOnTap);

  // strokeWidth 1.75 matches Helm's static icon set (animate-ui ships 2).
  const iconEl = <Icon size={size} strokeWidth={1.75} {...props} />;

  if (parent) return iconEl;

  return (
    <AnimateIconContext.Provider value={{ controls, animation }}>
      <motion.span style={{ display: 'inline-flex', lineHeight: 0 }} {...handlers}>
        {iconEl}
      </motion.span>
    </AnimateIconContext.Provider>
  );
}
