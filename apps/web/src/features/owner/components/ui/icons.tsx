import { Icon } from '@mbolo/ui';

type IconProps = { className?: string };

function wrap(IconComponent: typeof Icon.Play) {
  return function IconWrapper(props: IconProps) {
    return <IconComponent className={props.className ?? 'h-4 w-4'} aria-hidden />;
  };
}

export const IconOverview = wrap(Icon.LayoutDashboard);
export const IconSources = wrap(Icon.Cable);
export const IconImports = wrap(Icon.Download);
export const IconAudit = wrap(Icon.ShieldCheck);
export const IconPlus = wrap(Icon.Plus);
export const IconChevronRight = wrap(Icon.ChevronRight);
export const IconChevronLeft = wrap(Icon.ChevronLeft);
export const IconClock = wrap(Icon.Clock);
export const IconActivity = wrap(Icon.Activity);
export const IconLayers = wrap(Icon.Layers);
export const IconTv = wrap(Icon.Tv);
export const IconPlay = wrap(Icon.Play);
export const IconTrash = wrap(Icon.Trash2);
export const IconRefresh = wrap(Icon.RefreshCw);
export const IconCheck = wrap(Icon.Check);
export const IconAlert = wrap(Icon.AlertTriangle);
export const IconX = wrap(Icon.X);
export const IconCopy = wrap(Icon.Copy);
export const IconLink = wrap(Icon.Link);
export const IconServer = wrap(Icon.Server);
export const IconSearch = wrap(Icon.Search);
export const IconLogout = wrap(Icon.LogOut);
export const IconKey = wrap(Icon.Key);
export const IconPlug = wrap(Icon.Plug);
export const IconUsers = wrap(Icon.Users);
export const IconBell = wrap(Icon.Bell);
