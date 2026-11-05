/**
 * Icon set: Phosphor (https://phosphoricons.com, MIT), regular weight, 20px.
 * Components import icons from here only, so the set can be swapped in one place.
 */
import {
  ArrowCounterClockwiseIcon,
  BooksIcon,
  BroadcastIcon as PhBroadcast,
  CheckCircleIcon as PhCheckCircle,
  ClockIcon as PhClock,
  DotsSixVerticalIcon,
  FileAudioIcon as PhFileAudio,
  FlaskIcon as PhFlask,
  FolderOpenIcon,
  GearIcon as PhGear,
  GlobeIcon as PhGlobe,
  InfoIcon as PhInfo,
  LockSimpleIcon,
  MoonIcon as PhMoon,
  WifiSlashIcon,
  MagnifyingGlassIcon,
  MegaphoneIcon,
  MusicNotesIcon as PhMusicNotes,
  PlusIcon as PhPlus,
  QueueIcon as PhQueue,
  RepeatIcon as PhRepeat,
  SkipForwardIcon as PhSkipForward,
  SquaresFourIcon,
  TrashIcon as PhTrash,
  UploadSimpleIcon,
  WarningCircleIcon as PhWarningCircle,
  CircleNotchIcon,
  FadersIcon,
  HeadphonesIcon,
  PlayIcon as PhPlay,
  SpeakerHighIcon,
  SpeakerLowIcon,
  SpeakerNoneIcon,
  SpeakerXIcon,
  StopIcon as PhStop,
  VinylRecordIcon,
  XIcon,
  type Icon as PhosphorIcon,
  type IconProps as PhosphorIconProps,
} from "@phosphor-icons/react";

export const ICON_SIZE = 20;

export type IconProps = PhosphorIconProps;

/** Applies the house defaults; decorative unless an aria-label is given. */
function icon(Component: PhosphorIcon) {
  const Wrapped = (props: IconProps) => (
    <Component
      size={ICON_SIZE}
      weight="regular"
      aria-hidden={props["aria-label"] ? undefined : true}
      focusable={false}
      {...props}
    />
  );
  Wrapped.displayName = Component.displayName;
  return Wrapped;
}

export const PlayIcon = icon(PhPlay);
export const StopIcon = icon(PhStop);
export const SpinnerIcon = icon(CircleNotchIcon);
export const MuteIcon = icon(SpeakerXIcon);
export const EqIcon = icon(FadersIcon);
export const ListenersIcon = icon(HeadphonesIcon);
export const DiscIcon = icon(VinylRecordIcon);
export const ResetIcon = icon(ArrowCounterClockwiseIcon);
export const CloseIcon = icon(XIcon);

export const BroadcastIcon = icon(PhBroadcast);
export const SkipIcon = icon(PhSkipForward);
export const QueueIcon = icon(PhQueue);
export const MusicIcon = icon(PhMusicNotes);
export const JingleIcon = icon(MegaphoneIcon);
export const LibraryIcon = icon(BooksIcon);
export const DashboardIcon = icon(SquaresFourIcon);
export const SettingsIcon = icon(PhGear);
export const UploadIcon = icon(UploadSimpleIcon);
export const SearchIcon = icon(MagnifyingGlassIcon);
export const DragHandleIcon = icon(DotsSixVerticalIcon);
export const TrashIcon = icon(PhTrash);
export const PlusIcon = icon(PhPlus);
export const FolderIcon = icon(FolderOpenIcon);
export const FileAudioIcon = icon(PhFileAudio);
export const GlobeIcon = icon(PhGlobe);
export const FlaskIcon = icon(PhFlask);
export const CheckCircleIcon = icon(PhCheckCircle);
export const WarningIcon = icon(PhWarningCircle);
export const ClockIcon = icon(PhClock);
export const RepeatIcon = icon(PhRepeat);
export const InfoIcon = icon(PhInfo);
export const LockIcon = icon(LockSimpleIcon);
export const OffAirIcon = icon(PhMoon);
export const ConnectionIcon = icon(WifiSlashIcon);

const SpeakerNone = icon(SpeakerNoneIcon);
const SpeakerLow = icon(SpeakerLowIcon);
const SpeakerHigh = icon(SpeakerHighIcon);

/** Speaker icon that reflects the current level (0–1). */
export function VolumeIcon({ level = 1, ...props }: IconProps & { level?: number }) {
  const Component = level <= 0 ? SpeakerNone : level <= 0.5 ? SpeakerLow : SpeakerHigh;
  return <Component {...props} />;
}
