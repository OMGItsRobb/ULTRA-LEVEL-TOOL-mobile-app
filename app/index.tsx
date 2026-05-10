import { MaterialCommunityIcons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { useAudioPlayer, type AudioPlayer } from 'expo-audio';
import * as Haptics from 'expo-haptics';
import * as ScreenOrientation from 'expo-screen-orientation';
import { DeviceMotion, type DeviceMotionMeasurement } from 'expo-sensors';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
  Modal,
  PanResponder,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { SafeAreaView, useSafeAreaInsets } from 'react-native-safe-area-context';

type Unit = 'degrees' | 'riseRun' | 'percent';
type TargetMode = 'auto' | 'flat' | 'edge';
type Axis = 'x' | 'y' | 'z';
type RulerUnit = 'cm' | 'in';
type RulerPlacement = 'left' | 'right' | 'top' | 'bottom';

type Vector = {
  x: number;
  y: number;
  z: number;
};

type FlatAngles = {
  x: number;
  y: number;
};

type Reading = {
  angle: number;
  axis: Axis;
  flatAngles: FlatAngles | null;
  mode: Exclude<TargetMode, 'auto'>;
  oneAxis: boolean;
  rollAngle: number;
  signedAngle: number;
  bubble: {
    x: number;
    y: number;
  };
  vector: Vector;
};

type HistoryItem = {
  id: string;
  angle: number;
  flatAngles?: FlatAngles;
  mode: Reading['mode'];
  time: string;
};

// Treat any reading within this window as level enough to trigger the success state.
const LEVEL_TOLERANCE_DEGREES = 2;
// A history capture only counts as stable if the angle stays within this delta.
const STABLE_TOLERANCE_DEGREES = 2;
// Run device-motion updates fast enough for smooth UI feedback.
const SENSOR_INTERVAL_MS = 25;
// Target time constant for the gravity low-pass filter. Using a fixed tau and computing alpha
// from the actual elapsed time between samples keeps the filter stable on Android, where the
// OS only treats setUpdateInterval as a hint and may deliver events at irregular intervals.
const SENSOR_SMOOTH_TAU_MS = 100;
// Limit bubble travel so the gauge remains readable at steeper angles.
const BUBBLE_LIMIT_DEGREES = 12;
// Quantize degree-based readouts to full-degree steps.
const DEGREE_STEP = 1;
// Snap the roll gauge to zero aggressively when it is nearly centered.
const ROLL_SNAP_DEGREES = 0.5;
// Release the zero snap only after the device moves farther away.
const ROLL_RELEASE_DEGREES = 0.35;
// Clamp the roll-based color interpolation to a useful visual range.
const ROLL_COLOR_MAX_DEGREES = 12;
// Persist captured history under a stable app-scoped key.
const HISTORY_STORAGE_KEY = 'ultra-level-tool/history';
// Keep only the most recent captured readings.
const MAX_HISTORY_ITEMS = 50;
// Enforce a global cooldown between level dings so wobble cannot spam feedback.
const LEVEL_DING_COOLDOWN_MS = 4000;
const RULER_WIDTH = 44;
const RULER_GAP = 12;
const DP_PER_INCH = 160;
const DP_PER_CM = DP_PER_INCH / 2.54;
const RULER_HANDLE_HEIGHT = 34;
const RULER_HANDLE_WIDTH = 54;
const RULER_LABEL_WIDTH = 28;

const UNITS: { value: Unit; label: string }[] = [
  { value: 'degrees', label: 'Deg' },
  { value: 'riseRun', label: 'Rise' },
  { value: 'percent', label: '%' },
];

const MODES: { value: TargetMode; label: string; icon: keyof typeof MaterialCommunityIcons.glyphMap }[] = [
  { value: 'auto', label: 'Auto', icon: 'axis-arrow' },
  { value: 'flat', label: 'Flat', icon: 'phone-rotate-landscape' },
  { value: 'edge', label: 'Edge', icon: 'angle-acute' },
];

const MODE_LABELS: Record<Reading['mode'], string> = {
  flat: 'Flat',
  edge: 'Edge',
};

/** Clamp a numeric value into an inclusive range. */
function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

/** Normalize raw motion data into a unit vector so the angle math stays stable. */
function normalize(measurement: Pick<Vector, 'x' | 'y' | 'z'>): Vector {
  const length = Math.hypot(measurement.x, measurement.y, measurement.z) || 1;

  return {
    x: measurement.x / length,
    y: measurement.y / length,
    z: measurement.z / length,
  };
}

/** Blend the previous vector with the newest one to reduce sensor jitter.
 *
 * `dt` is the milliseconds elapsed since the last sample. Using the actual dt
 * instead of a hardcoded weight keeps the effective time-constant consistent on
 * Android, where the OS delivers sensor events at irregular intervals even when
 * a specific rate is requested.
 */
function mixVectors(previous: Vector | null, next: Vector, dt: number = SENSOR_INTERVAL_MS) {
  if (!previous) {
    return next;
  }

  const alpha = 1 - Math.exp(-dt / SENSOR_SMOOTH_TAU_MS);

  return normalize({
    x: previous.x * (1 - alpha) + next.x * alpha,
    y: previous.y * (1 - alpha) + next.y * alpha,
    z: previous.z * (1 - alpha) + next.z * alpha,
  });
}

/** Project a vector onto another axis vector. */
function dot(vector: Vector, axis: Vector) {
  return vector.x * axis.x + vector.y * axis.y + vector.z * axis.z;
}

/** Ease a 0..1 value for smoother visual interpolation. */
function smoothstep(value: number) {
  const t = clamp(value, 0, 1);

  return t * t * (3 - 2 * t);
}

/** Interpolate between two hex colors and return an rgb() string for styling. */
function mixColor(start: string, end: string, amount: number) {
  const clamped = clamp(amount, 0, 1);
  const startValue = Number.parseInt(start.slice(1), 16);
  const endValue = Number.parseInt(end.slice(1), 16);
  const startRed = (startValue >> 16) & 0xff;
  const startGreen = (startValue >> 8) & 0xff;
  const startBlue = startValue & 0xff;
  const endRed = (endValue >> 16) & 0xff;
  const endGreen = (endValue >> 8) & 0xff;
  const endBlue = endValue & 0xff;
  const red = Math.round(startRed + (endRed - startRed) * clamped);
  const green = Math.round(startGreen + (endGreen - startGreen) * clamped);
  const blue = Math.round(startBlue + (endBlue - startBlue) * clamped);

  return `rgb(${red}, ${green}, ${blue})`;
}

/** Map the current screen orientation to the axes the UI considers right and up. */
function getUiAxes(orientation: ScreenOrientation.Orientation) {
  if (orientation === ScreenOrientation.Orientation.PORTRAIT_DOWN) {
    return {
      right: { x: -1, y: 0, z: 0 },
      up: { x: 0, y: -1, z: 0 },
    };
  }

  if (orientation === ScreenOrientation.Orientation.LANDSCAPE_LEFT) {
    return {
      right: { x: 0, y: 1, z: 0 },
      up: { x: -1, y: 0, z: 0 },
    };
  }

  if (orientation === ScreenOrientation.Orientation.LANDSCAPE_RIGHT) {
    return {
      right: { x: 0, y: -1, z: 0 },
      up: { x: 1, y: 0, z: 0 },
    };
  }

  return {
    right: { x: 1, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
  };
}

/** Convert the current gravity vector into a roll angle for the active UI orientation. */
function getRollFromVector(vector: Vector, orientation: ScreenOrientation.Orientation) {
  const { right, up } = getUiAxes(orientation);
  const gravityRight = dot(vector, right);
  const gravityUp = dot(vector, up);
  const projectionMagnitude = Math.hypot(gravityRight, gravityUp);

  if (projectionMagnitude < 0.0001) {
    return 0;
  }

  return Math.atan2(gravityRight, -gravityUp) * (180 / Math.PI);
}

/**
 * Derive the displayed reading from gravity, including the active mode,
 * signed angle, roll angle, and bubble position for the gauge.
 */
function readingFromVector(
  vector: Vector,
  selectedMode: TargetMode,
  orientation: ScreenOrientation.Orientation
): Reading {
  const { right, up } = getUiAxes(orientation);
  const gravityRight = dot(vector, right);
  const gravityUp = dot(vector, up);
  const gravityOut = vector.z;
  const rollAngle = getRollFromVector(vector, orientation);
  const flatReference = Math.abs(gravityOut);
  const useFlat = selectedMode === 'flat' || (selectedMode === 'auto' && Math.abs(gravityOut) > 0.72);
  const mode: Reading['mode'] = useFlat ? 'flat' : 'edge';
  const axis: Axis = useFlat ? 'z' : Math.abs(up.x) > 0 ? 'x' : 'y';
  const flatX = Math.atan2(gravityRight, flatReference) * (180 / Math.PI);
  const flatY = Math.atan2(gravityUp, flatReference) * (180 / Math.PI);
  const flatAngle = Math.atan2(
    Math.hypot(gravityRight, gravityUp),
    flatReference
  ) * (180 / Math.PI);
  const flatAngles = useFlat
    ? {
      x: -flatX,
      y: -flatY,
    }
    : null;
  const flatSignedAngle = Math.abs(flatX) >= Math.abs(flatY) ? -flatX : -flatY;
  const edgeSignedAngle = rollAngle;
  const edgeAngle = Math.abs(edgeSignedAngle);
  const signedAngle = useFlat ? flatSignedAngle : edgeSignedAngle;
  const angle = Math.abs(signedAngle);
  const bubbleLimit = Math.sin(BUBBLE_LIMIT_DEGREES * (Math.PI / 180));
  const bubble = useFlat
    ? {
      x: clamp(-gravityRight / bubbleLimit, -1, 1),
      y: clamp(gravityUp / bubbleLimit, -1, 1),
    }
    : {
      x: clamp(-gravityRight / bubbleLimit, -1, 1),
      y: 0,
    };

  return {
    angle: useFlat ? flatAngle : angle,
    axis,
    flatAngles,
    mode,
    oneAxis: !useFlat,
    rollAngle,
    signedAngle,
    bubble,
    vector,
  };
}

/** Round the display angle to the configured step and normalize negative zero. */
function roundDegreeDisplayAngle(angle: number) {
  const rounded = Math.round(angle / DEGREE_STEP) * DEGREE_STEP;

  return Object.is(rounded, -0) ? 0 : rounded;
}

/** Convert an angle in degrees to a signed percent grade. */
function angleToPercent(angle: number) {
  const slope = Math.tan(Math.abs(angle) * (Math.PI / 180)) * 100;

  if (!Number.isFinite(slope)) {
    return angle < 0 ? Number.NEGATIVE_INFINITY : Number.POSITIVE_INFINITY;
  }

  return angle < 0 ? -slope : slope;
}

/** Convert a signed percent grade back into an angle in degrees. */
function percentToAngle(percent: number) {
  const angle = Math.atan(Math.abs(percent) / 100) * (180 / Math.PI);
  const signedAngle = percent < 0 ? -angle : angle;

  return Object.is(signedAngle, -0) ? 0 : signedAngle;
}

/** Round the displayed angle using the active output unit's precision. */
function roundDisplayAngle(angle: number, unit: Unit) {
  if (unit === 'percent') {
    const roundedPercent = Math.round(angleToPercent(angle));

    return percentToAngle(roundedPercent);
  }

  return roundDegreeDisplayAngle(angle);
}

/** Build tick metadata for one ruler track. */
function buildRulerMarks(length: number, unit: RulerUnit) {
  const majorStep = unit === 'cm' ? DP_PER_CM : DP_PER_INCH;
  const subdivisions = unit === 'cm' ? 10 : 8;
  const halfSubdivision = Math.max(1, Math.floor(subdivisions / 2));
  const minorStep = majorStep / subdivisions;
  const totalSteps = Math.floor(length / minorStep);

  return Array.from({ length: totalSteps + 1 }, (_, index) => {
    const isMajor = index % subdivisions === 0;
    const isMedium = !isMajor && index % halfSubdivision === 0;

    return {
      id: `${unit}-${index}`,
      label: isMajor ? `${Math.round(index / subdivisions)}` : null,
      size: isMajor ? 'long' : isMedium ? 'medium' : 'short',
      top: index * minorStep,
    };
  });
}

/** Guard persisted flat-axis readings before restoring them from storage. */
function isFlatAngles(value: unknown): value is FlatAngles {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<FlatAngles>;

  return typeof candidate.x === 'number' && typeof candidate.y === 'number';
}

/** Guard persisted history before restoring it from storage. */
function isHistoryItem(value: unknown): value is HistoryItem {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const candidate = value as Partial<HistoryItem>;

  if (candidate.flatAngles !== undefined && !isFlatAngles(candidate.flatAngles)) {
    return false;
  }

  return (
    typeof candidate.id === 'string' &&
    typeof candidate.angle === 'number' &&
    (candidate.mode === 'flat' || candidate.mode === 'edge') &&
    typeof candidate.time === 'string'
  );
}

/** Render a decorative ruler along one edge of the screen. */
function SideRuler({
  offset = 0,
  length,
  placement,
  unit,
}: {
  offset?: Animated.Value | number;
  length: number;
  placement: RulerPlacement;
  unit: RulerUnit;
}) {
  const marks = useMemo(() => buildRulerMarks(length, unit), [length, unit]);
  const isVertical = placement === 'left' || placement === 'right';

  return (
    <View
      pointerEvents="none"
      style={[
        styles.ruler,
        isVertical ? styles.rulerVertical : styles.rulerHorizontal,
        placement === 'left'
          ? styles.rulerLeft
          : placement === 'right'
            ? styles.rulerRight
            : placement === 'top'
              ? styles.rulerTop
              : styles.rulerBottom,
      ]}>
      <View
        style={[
          styles.rulerEdge,
          placement === 'left'
            ? styles.rulerEdgeLeft
            : placement === 'right'
              ? styles.rulerEdgeRight
              : placement === 'top'
                ? styles.rulerEdgeTop
                : styles.rulerEdgeBottom,
        ]}
      />
      <Animated.View
        style={[
          styles.rulerTrack,
          isVertical ? styles.rulerTrackVertical : styles.rulerTrackHorizontal,
          isVertical
            ? { height: length, transform: [{ translateY: offset }] }
            : { width: length, transform: [{ translateX: offset }] },
        ]}>
        {marks.map((mark) => (
          <React.Fragment key={mark.id}>
            <View
              style={[
                styles.rulerTick,
                isVertical ? styles.rulerTickVertical : styles.rulerTickHorizontal,
                isVertical
                  ? mark.size === 'long'
                    ? styles.rulerTickLong
                    : mark.size === 'medium'
                      ? styles.rulerTickMedium
                      : styles.rulerTickShort
                  : mark.size === 'long'
                    ? styles.rulerTickLongHorizontal
                    : mark.size === 'medium'
                      ? styles.rulerTickMediumHorizontal
                      : styles.rulerTickShortHorizontal,
                placement === 'left'
                  ? styles.rulerTickLeft
                  : placement === 'right'
                    ? styles.rulerTickRight
                    : placement === 'top'
                      ? styles.rulerTickTop
                      : styles.rulerTickBottom,
                isVertical ? { top: mark.top } : { left: mark.top },
              ]}
            />
            {mark.label ? (
              <Text
                style={[
                  styles.rulerLabel,
                  placement === 'left'
                    ? styles.rulerLabelLeft
                    : placement === 'right'
                      ? styles.rulerLabelRight
                      : placement === 'top'
                        ? styles.rulerLabelTop
                        : styles.rulerLabelBottom,
                  isVertical
                    ? { top: Math.max(0, mark.top - 7) }
                    : { left: Math.max(0, mark.top - RULER_LABEL_WIDTH / 2) },
                ]}>
                {mark.label}
              </Text>
            ) : null}
          </React.Fragment>
        ))}
      </Animated.View>
      <View
        style={[
          styles.rulerUnitBadge,
          placement === 'left'
            ? styles.rulerUnitBadgeLeft
            : placement === 'right'
              ? styles.rulerUnitBadgeRight
              : placement === 'top'
                ? styles.rulerUnitBadgeTop
                : styles.rulerUnitBadgeBottom,
        ]}>
        <Text style={styles.rulerUnitText}>{unit}</Text>
      </View>
    </View>
  );
}

/** Format the main readout using the selected output unit. */
function formatPrimary(angle: number, unit: Unit) {
  const sign = angle > 0 ? '+' : '';

  if (unit === 'degrees') {
    return `${sign}${Math.round(angle)}°`;
  }

  const signedPercent = angleToPercent(angle);
  const slope = Math.abs(signedPercent) / 100;

  if (!Number.isFinite(slope) || slope > 99) {
    return 'Vertical';
  }

  if (unit === 'percent') {
    const wholePercent = Math.round(signedPercent);

    return `${wholePercent > 0 ? '+' : ''}${wholePercent}%`;
  }

  const rise = Math.round(slope * 12) * (angle < 0 ? -1 : 1);

  return `${rise > 0 ? '+' : ''}${rise}/12`;
}

/** Format the smaller supporting readout shown under the main value. */
function formatSecondary(angle: number, unit: Unit) {
  const sign = angle > 0 ? '+' : '';

  if (unit === 'degrees') {
    return `${sign}${Math.round(angle)} degrees`;
  }

  const signedPercent = angleToPercent(angle);
  const slope = Math.abs(signedPercent) / 100;

  if (!Number.isFinite(slope) || slope > 99) {
    return 'Vertical';
  }

  if (unit === 'percent') {
    const wholePercent = Math.round(signedPercent);

    return `${wholePercent > 0 ? '+' : ''}${wholePercent}% grade`;
  }

  const rise = Math.round(slope * 12) * (angle < 0 ? -1 : 1);

  return `${rise > 0 ? '+' : ''}${rise}/12 rise`;
}

/** Format both flat-mode axes using the active unit so they can be shown together. */
function formatFlatAxisSummary(flatAngles: FlatAngles, unit: Unit) {
  return `X ${formatPrimary(flatAngles.x, unit)} · Y ${formatPrimary(flatAngles.y, unit)}`;
}

/** Restart and play a short UI sound if sound effects are enabled. */
function playCue(player: AudioPlayer, soundEnabled: boolean) {
  if (!soundEnabled) {
    return;
  }

  player.seekTo(0).catch(() => undefined);
  player.play();
}

/** Centralize orientation behavior so mode and modal transitions stay consistent. */
async function applyOrientationLock(mode: TargetMode) {
  if (mode === 'flat') {
    await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT);
    return;
  }

  await ScreenOrientation.unlockAsync();
}

/** Main level screen that renders the live gauge, rulers, controls, and history modal. */
export default function HomeScreen() {
  const { height, width } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [vector, setVector] = useState<Vector | null>(null);
  const [unit, setUnit] = useState<Unit>('degrees');
  const [mode, setMode] = useState<TargetMode>('auto');
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const [historyHydrated, setHistoryHydrated] = useState(false);
  const [historyVisible, setHistoryVisible] = useState(false);
  const [historyIndex, setHistoryIndex] = useState(0);
  const [soundEnabled, setSoundEnabled] = useState(true);
  const [sensorStatus, setSensorStatus] = useState('Starting sensors');
  const [screenOrientation, setScreenOrientation] = useState(ScreenOrientation.Orientation.UNKNOWN);
  const [lockStatus, setLockStatus] = useState('Auto target');

  const dingPlayer = useAudioPlayer(require('@/assets/sounds/level-ding.wav'), {
    keepAudioSessionActive: true,
  });
  const capturePlayer = useAudioPlayer(require('@/assets/sounds/level-capture.wav'), {
    keepAudioSessionActive: true,
  });
  // Shared ruler track offset so both rulers move together.
  const rulerOffset = useRef(new Animated.Value(0)).current;
  // Temporary handle displacement so the grabber can spring back after each drag.
  const rulerHandleOffset = useRef(new Animated.Value(0)).current;

  // Start time for the current "level" streak.
  const levelSinceRef = useRef<number | null>(null);
  // Prevent repeated dings inside the same stable level streak.
  const levelDingedRef = useRef(false);
  // Enforce a cooldown between level dings even if the sensor quickly re-enters tolerance.
  const lastLevelDingAtRef = useRef<number>(-LEVEL_DING_COOLDOWN_MS);
  // Keep the roll indicator snapped at zero until the device moves far enough away.
  const rollSnapRef = useRef(false);
  // Numeric backing value for the shared ruler offset.
  const rulerOffsetRef = useRef(0);
  // Keep the headline angle snapped at zero while it hovers around level.
  const zeroSnappedRef = useRef(false);
  // Timestamp of the most recent gravity sensor sample, used to compute dt for the EMA filter.
  const lastSensorTimeRef = useRef<number | null>(null);
  // Track the current stable reading window before auto-capturing it into history.
  const stableRef = useRef<{
    angle: number;
    flatAngles: FlatAngles | null;
    mode: Reading['mode'];
    since: number;
    saved: boolean;
  } | null>(null);

  const reading = useMemo(() => {
    if (!vector) {
      return null;
    }

    return readingFromVector(vector, mode, screenOrientation);
  }, [mode, screenOrientation, vector]);

  const bubble = useMemo(() => {
    if (!reading) {
      return { x: 0, y: 0 };
    }

    return reading.bubble;
  }, [reading]);

  const isLandscape = width > height;
  const baseHorizontalPadding = isLandscape ? 14 : 20;
  const baseTopPadding = isLandscape ? 6 : 12;
  const baseBottomPadding = isLandscape ? 10 : 16;
  const contentHorizontalPadding = baseHorizontalPadding + (isLandscape ? 0 : RULER_WIDTH + RULER_GAP);
  const contentTopPadding = baseTopPadding + (isLandscape ? RULER_WIDTH + RULER_GAP : 0);
  const contentBottomPadding = baseBottomPadding + (isLandscape ? RULER_WIDTH + RULER_GAP : 0);
  const availableContentWidth = width - insets.left - insets.right - contentHorizontalPadding * 2;
  const availableContentHeight = height - insets.top - insets.bottom - contentTopPadding - contentBottomPadding;
  const rulerLength = Math.max(0, height - insets.top - insets.bottom);
  const rulerAxisLength = isLandscape
    ? Math.max(0, width - insets.left - insets.right)
    : rulerLength;
  const rulerScrollRange = Math.max(rulerLength, DP_PER_CM * 24);
  const rulerTrackLength = rulerAxisLength + rulerScrollRange;
  const rulerPositiveOffsetLimit = Math.max(rulerAxisLength * 0.72, DP_PER_CM * 8);
  const rulerHandleTravel = Math.max(
    rulerAxisLength / 2 - (isLandscape ? RULER_HANDLE_WIDTH : RULER_HANDLE_HEIGHT),
    0
  );
  const rulerHandleTop = insets.top + rulerLength / 2 - RULER_HANDLE_HEIGHT / 2;
  const rulerHandleLeft = insets.left + rulerAxisLength / 2 - RULER_HANDLE_WIDTH / 2;
  const gaugeSize = isLandscape
    ? clamp(Math.min(availableContentWidth * 0.38, availableContentHeight - 56), 120, 260)
    : clamp(Math.min(availableContentWidth, Math.min(availableContentHeight * 0.4, height * 0.33)), 140, 360);
  const rollVisualAngle = useMemo(() => {
    if (!reading || reading.mode !== 'edge') {
      rollSnapRef.current = false;
      return null;
    }

    const rawRollAngle = reading.rollAngle;
    const snapThreshold = rollSnapRef.current ? ROLL_RELEASE_DEGREES : ROLL_SNAP_DEGREES;

    if (Math.abs(rawRollAngle) <= snapThreshold) {
      rollSnapRef.current = true;
      return 0;
    }

    rollSnapRef.current = false;
    return rawRollAngle;
  }, [reading]);
  const displayAngle = useMemo(() => {
    if (!reading) {
      zeroSnappedRef.current = false;
      return null;
    }

    if (reading.mode === 'edge' && rollVisualAngle !== null) {
      return roundDisplayAngle(rollVisualAngle, unit);
    }

    const roundedAngle = roundDisplayAngle(reading.signedAngle, unit);
    const snapThreshold = zeroSnappedRef.current ? 0.75 : 0.25;

    if (Math.abs(roundedAngle) <= snapThreshold) {
      zeroSnappedRef.current = true;
      return 0;
    }

    zeroSnappedRef.current = false;
    return roundedAngle;
  }, [reading, rollVisualAngle, unit]);
  const isLevel = Boolean(displayAngle !== null && Math.abs(displayAngle) <= LEVEL_TOLERANCE_DEGREES);
  const rollAlignmentIntensity = useMemo(() => {
    if (rollVisualAngle === null) {
      return 0;
    }

    return smoothstep(clamp(1 - Math.abs(rollVisualAngle / ROLL_COLOR_MAX_DEGREES), 0, 1));
  }, [rollVisualAngle]);
  const gaugeBackgroundColor = useMemo(() => {
    if (rollVisualAngle === null) {
      return '#07090B';
    }

    if (rollVisualAngle === 0) {
      return '#C7FF5A';
    }

    const midColor = mixColor('#07090B', '#1F3E2A', Math.min(rollAlignmentIntensity * 1.2, 1));

    return mixColor(midColor, '#C7FF5A', Math.max(0, (rollAlignmentIntensity - 0.62) / 0.38));
  }, [rollAlignmentIntensity, rollVisualAngle]);
  const gaugeAccentColor = useMemo(
    () => mixColor('#FFFFFF', '#0A1302', Math.max(0, rollAlignmentIntensity - 0.15)),
    [rollAlignmentIntensity]
  );
  const primaryDisplay =
    displayAngle !== null
      ? formatPrimary(displayAngle, unit)
      : unit === 'percent'
        ? '--%'
        : unit === 'riseRun'
          ? '--/12'
          : '--°';
  const supportingUnit: Unit = unit === 'degrees' ? 'riseRun' : 'degrees';
  const flatDisplayAngles = useMemo(() => {
    if (!reading?.flatAngles) {
      return null;
    }

    return {
      x: roundDisplayAngle(reading.flatAngles.x, unit),
      y: roundDisplayAngle(reading.flatAngles.y, unit),
    };
  }, [reading, unit]);
  const secondaryDisplay =
    displayAngle !== null
      ? reading?.mode === 'flat' && flatDisplayAngles
        ? formatFlatAxisSummary(flatDisplayAngles, unit)
        : formatSecondary(displayAngle, supportingUnit)
      : 'Waiting for motion data';
  const targetLabel = reading ? MODE_LABELS[reading.mode] : 'Starting';
  const historyPageSize = isLandscape ? 4 : 3;
  const maxHistoryStart = Math.max(history.length - historyPageSize, 0);
  const visibleHistoryItems = history.slice(historyIndex, historyIndex + historyPageSize);
  const visibleHistoryEnd = Math.min(historyIndex + visibleHistoryItems.length, history.length);
  const canShowNewerHistory = historyIndex > 0;
  const canShowOlderHistory = visibleHistoryEnd < history.length;

  /** Persist the shared ruler offset after a drag completes. */
  function commitRulerOffset(dragDelta: number) {
    const nextOffset = clamp(
      rulerOffsetRef.current + dragDelta,
      -rulerScrollRange,
      rulerPositiveOffsetLimit
    );

    rulerOffsetRef.current = nextOffset;
    rulerOffset.setValue(nextOffset);
  }

  const rightRulerPanResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          isLandscape ? Math.abs(gesture.dx) > Math.abs(gesture.dy) : Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderMove: (_, gesture) => {
          const primaryDelta = isLandscape ? gesture.dx : gesture.dy;
          const nextOffset = clamp(
            rulerOffsetRef.current + primaryDelta,
            -rulerScrollRange,
            rulerPositiveOffsetLimit
          );

          rulerOffset.setValue(nextOffset);
          rulerHandleOffset.setValue(
            clamp(primaryDelta, -rulerHandleTravel, rulerHandleTravel)
          );
        },
        onPanResponderRelease: (_, gesture) => {
          commitRulerOffset(isLandscape ? gesture.dx : gesture.dy);

          Animated.spring(rulerHandleOffset, {
            damping: 20,
            mass: 0.7,
            stiffness: 260,
            toValue: 0,
            useNativeDriver: true,
          }).start();
        },
        onPanResponderTerminate: (_, gesture) => {
          commitRulerOffset(isLandscape ? gesture.dx : gesture.dy);

          Animated.spring(rulerHandleOffset, {
            damping: 20,
            mass: 0.7,
            stiffness: 260,
            toValue: 0,
            useNativeDriver: true,
          }).start();
        },
      }),
    [isLandscape, rulerHandleOffset, rulerHandleTravel, rulerOffset, rulerPositiveOffsetLimit, rulerScrollRange]
  );

  useEffect(() => {
    rulerOffsetRef.current = clamp(rulerOffsetRef.current, -rulerScrollRange, rulerPositiveOffsetLimit);
    rulerOffset.setValue(rulerOffsetRef.current);
    rulerHandleOffset.setValue(0);
  }, [rulerHandleOffset, rulerOffset, rulerPositiveOffsetLimit, rulerScrollRange]);

  useEffect(() => {
    let subscription: { remove: () => void } | null = null;
    let mounted = true;

    ScreenOrientation.getOrientationAsync()
      .then((orientation) => {
        if (mounted) {
          setScreenOrientation(orientation);
        }
      })
      .catch(() => undefined);

    subscription = ScreenOrientation.addOrientationChangeListener((event) => {
      setScreenOrientation(event.orientationInfo.orientation);
    });

    return () => {
      mounted = false;
      subscription?.remove();
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    /** Restore persisted history once on startup before save effects are allowed to run. */
    async function loadHistory() {
      try {
        const storedHistory = await AsyncStorage.getItem(HISTORY_STORAGE_KEY);

        if (!mounted || !storedHistory) {
          return;
        }

        const parsedHistory: unknown = JSON.parse(storedHistory);

        if (!Array.isArray(parsedHistory)) {
          return;
        }

        const sanitizedHistory = parsedHistory.filter(isHistoryItem).slice(0, MAX_HISTORY_ITEMS);

        if (mounted) {
          setHistory(sanitizedHistory);
        }
      } catch {
        if (mounted) {
          setHistory([]);
        }
      } finally {
        if (mounted) {
          setHistoryHydrated(true);
        }
      }
    }

    loadHistory().catch(() => {
      if (mounted) {
        setHistoryHydrated(true);
      }
    });

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    if (!historyHydrated) {
      return;
    }

    AsyncStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(history.slice(0, MAX_HISTORY_ITEMS))).catch(() => undefined);
  }, [history, historyHydrated]);

  useEffect(() => {
    let subscription: { remove: () => void } | null = null;
    let mounted = true;

    /** Start the device-motion stream and smooth incoming gravity updates for the UI. */
    async function startDeviceMotion() {
      const available = await DeviceMotion.isAvailableAsync();

      if (!available) {
        setSensorStatus('No motion sensor available');
        return;
      }

      if (!mounted) {
        return;
      }

      DeviceMotion.setUpdateInterval(SENSOR_INTERVAL_MS);
      subscription = DeviceMotion.addListener((measurement: DeviceMotionMeasurement) => {
        const gravity = measurement.accelerationIncludingGravity;

        if (
          !gravity ||
          !Number.isFinite(gravity.x) ||
          !Number.isFinite(gravity.y) ||
          !Number.isFinite(gravity.z)
        ) {
          setSensorStatus('Waiting for gravity data');
          return;
        }

        const nextVector = normalize(gravity);
        const now = Date.now();
        const dt = lastSensorTimeRef.current !== null ? now - lastSensorTimeRef.current : SENSOR_INTERVAL_MS;
        lastSensorTimeRef.current = now;
        setVector((current) => mixVectors(current, nextVector, dt));
        setSensorStatus('Live');
      });
    }

    startDeviceMotion().catch(() => setSensorStatus('Sensor unavailable'));

    return () => {
      mounted = false;
      subscription?.remove();
      lastSensorTimeRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (!reading) {
      return;
    }

    const now = Date.now();

    if (isLevel) {
      if (levelSinceRef.current === null) {
        levelSinceRef.current = now;
        levelDingedRef.current = false;
      } else if (
        now - levelSinceRef.current >= 500 &&
        !levelDingedRef.current &&
        now - lastLevelDingAtRef.current >= LEVEL_DING_COOLDOWN_MS
      ) {
        playCue(dingPlayer, soundEnabled);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(() => undefined);
        lastLevelDingAtRef.current = now;
        levelDingedRef.current = true;
      }
    } else {
      levelSinceRef.current = null;
      levelDingedRef.current = false;
    }

    const stableReading = stableRef.current;
    const stableAngle = roundDegreeDisplayAngle(reading.signedAngle);
    const stableFlatAngles = reading.flatAngles
      ? {
        x: roundDegreeDisplayAngle(reading.flatAngles.x),
        y: roundDegreeDisplayAngle(reading.flatAngles.y),
      }
      : null;
    const hasMoved =
      !stableReading ||
      stableReading.mode !== reading.mode ||
      Math.abs(stableReading.angle - stableAngle) > STABLE_TOLERANCE_DEGREES ||
      (stableFlatAngles
        ? !stableReading.flatAngles ||
        Math.abs(stableReading.flatAngles.x - stableFlatAngles.x) > STABLE_TOLERANCE_DEGREES ||
        Math.abs(stableReading.flatAngles.y - stableFlatAngles.y) > STABLE_TOLERANCE_DEGREES
        : stableReading.flatAngles !== null);

    if (hasMoved) {
      stableRef.current = {
        angle: stableAngle,
        flatAngles: stableFlatAngles,
        mode: reading.mode,
        since: now,
        saved: false,
      };
      return;
    }

    if (now - stableReading.since >= 3000 && !stableReading.saved) {
      playCue(capturePlayer, soundEnabled);
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(() => undefined);

      stableRef.current = {
        ...stableReading,
        saved: true,
      };

      const item: HistoryItem = {
        id: `${now}`,
        angle: stableAngle,
        flatAngles: stableFlatAngles ?? undefined,
        mode: reading.mode,
        time: new Date(now).toLocaleTimeString([], {
          hour: 'numeric',
          minute: '2-digit',
          second: '2-digit',
        }),
      };

      setHistory((items) => [item, ...items].slice(0, MAX_HISTORY_ITEMS));
      setHistoryIndex(0);
    }
  }, [capturePlayer, dingPlayer, isLevel, reading, soundEnabled]);

  useEffect(() => {
    setHistoryIndex((current) => clamp(current, 0, maxHistoryStart));
  }, [maxHistoryStart]);

  /** Clear the captured history and reset the modal paging position. */
  function clearHistory() {
    setHistory([]);
    setHistoryIndex(0);
  }

  /** Open the history modal and force portrait first when launched from landscape. */
  async function openHistory() {
    setHistoryIndex(0);

    if (isLandscape) {
      try {
        await ScreenOrientation.lockAsync(ScreenOrientation.OrientationLock.PORTRAIT_UP);
      } catch {
        // Fall back to opening the modal even if the orientation lock fails.
      }
    }

    setHistoryVisible(true);
  }

  /** Close the history modal and restore the orientation behavior for the active mode. */
  async function closeHistory() {
    setHistoryVisible(false);

    try {
      await applyOrientationLock(mode);
    } catch {
      // Ignore orientation unlock failures on dismiss.
    }
  }

  /** Switch targets and clear any stale stability state from the previous mode. */
  async function selectMode(nextMode: TargetMode) {
    setMode(nextMode);
    stableRef.current = null;
    levelSinceRef.current = null;
    levelDingedRef.current = false;

    try {
      await applyOrientationLock(nextMode);
      setLockStatus(nextMode === 'auto' ? 'Auto target' : `${MODES.find((item) => item.value === nextMode)?.label} locked`);
    } catch {
      setLockStatus('Target locked');
    }
  }

  return (
    <SafeAreaView edges={['top', 'bottom', 'left', 'right']} style={styles.screen}>
      {isLandscape ? (
        <>
          <SideRuler length={rulerTrackLength} offset={rulerOffset} placement="top" unit="in" />
          <SideRuler length={rulerTrackLength} offset={rulerOffset} placement="bottom" unit="cm" />
        </>
      ) : (
        <>
          <SideRuler length={rulerTrackLength} offset={rulerOffset} placement="left" unit="in" />
          <SideRuler length={rulerTrackLength} offset={rulerOffset} placement="right" unit="cm" />
        </>
      )}

      <Animated.View
        style={[
          styles.rulerGrabHandle,
          isLandscape ? styles.rulerGrabHandleLandscape : styles.rulerGrabHandlePortrait,
          isLandscape
            ? { left: rulerHandleLeft, transform: [{ translateX: rulerHandleOffset }] }
            : { top: rulerHandleTop, transform: [{ translateY: rulerHandleOffset }] },
        ]}
        {...rightRulerPanResponder.panHandlers}>
        <MaterialCommunityIcons name={isLandscape ? 'drag-horizontal' : 'drag-vertical'} size={18} color="#000000" />
      </Animated.View>

      <View
        style={[
          styles.content,
          isLandscape && styles.contentLandscape,
          {
            paddingBottom: contentBottomPadding,
            paddingHorizontal: contentHorizontalPadding,
            paddingTop: contentTopPadding,
          },
        ]}>
        <View style={[styles.header, isLandscape && styles.headerLandscape]}>
          <View>
            {!isLandscape && <Text style={styles.kicker}>Ultra Level</Text>}
            <Text style={[styles.title, isLandscape && styles.titleLandscape]}>{targetLabel}</Text>
          </View>
          <View style={[styles.headerActions, isLandscape && styles.headerActionsLandscape]}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={history.length === 0 ? 'Open saved readings' : `Open ${history.length} saved readings`}
              onPress={() => {
                openHistory().catch(() => undefined);
              }}
              style={({ pressed }) => [
                styles.iconButton,
                isLandscape && styles.iconButtonLandscape,
                pressed && styles.pressed,
              ]}>
              <MaterialCommunityIcons name="history" size={22} color="#FFFFFF" />
              {history.length > 0 ? (
                <View style={styles.historyBadge}>
                  <Text style={styles.historyBadgeText}>{history.length > 99 ? '99+' : history.length}</Text>
                </View>
              ) : null}
            </Pressable>

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={soundEnabled ? 'Turn sound off' : 'Turn sound on'}
              onPress={() => setSoundEnabled((current) => !current)}
              style={({ pressed }) => [
                styles.iconButton,
                isLandscape && styles.iconButtonLandscape,
                pressed && styles.pressed,
              ]}>
              <MaterialCommunityIcons
                name={soundEnabled ? 'volume-high' : 'volume-off'}
                size={24}
                color="#FFFFFF"
              />
            </Pressable>
          </View>
        </View>

        <View style={[styles.mainArea, isLandscape && styles.mainAreaLandscape]}>
          <View style={styles.gaugeColumn}>
            <View
              style={[
                styles.gauge,
                {
                  backgroundColor: gaugeBackgroundColor,
                  borderColor: gaugeAccentColor,
                  width: gaugeSize,
                  height: gaugeSize,
                },
              ]}>
              {reading?.oneAxis ? (
                <>
                  <View
                    style={[
                      styles.rail,
                      styles.railHorizontal,
                      { backgroundColor: gaugeAccentColor },
                    ]}
                  />
                  <View style={[styles.railCenter, { borderColor: gaugeAccentColor }]} />
                </>
              ) : (
                <>
                  <View style={[styles.crosshairVertical, { backgroundColor: gaugeAccentColor }]} />
                  <View style={[styles.crosshairHorizontal, { backgroundColor: gaugeAccentColor }]} />
                  <View style={[styles.centerRing, { borderColor: gaugeAccentColor }]} />
                </>
              )}
              <View
                style={[
                  styles.bubble,
                  isLevel && styles.bubbleLevel,
                  { backgroundColor: rollAlignmentIntensity > 0.75 ? '#0A1302' : '#FFFFFF' },
                  {
                    transform: [
                      { translateX: bubble.x * (gaugeSize / 2 - 40) },
                      { translateY: bubble.y * (gaugeSize / 2 - 40) },
                    ],
                  },
                ]}
              />
            </View>
          </View>

          <View style={[styles.controlsColumn, isLandscape && styles.controlsColumnLandscape]}>
            <View style={[styles.readout, isLandscape && styles.readoutLandscape]}>
              <Text style={[styles.degreeText, isLandscape && styles.degreeTextLandscape]}>
                {primaryDisplay}
              </Text>
              <Text style={styles.secondaryText}>{secondaryDisplay}</Text>
              <Text style={styles.statusText}>
                {isLevel ? 'Level' : lockStatus} · {sensorStatus}
              </Text>
            </View>

            <View style={[styles.segmentGroup, isLandscape && styles.segmentGroupLandscape]}>
              {UNITS.map((item) => (
                <Pressable
                  accessibilityRole="button"
                  key={item.value}
                  onPress={() => setUnit(item.value)}
                  style={({ pressed }) => [
                    styles.segment,
                    isLandscape && styles.segmentLandscape,
                    unit === item.value && styles.segmentActive,
                    pressed && styles.pressed,
                  ]}>
                  <Text style={[styles.segmentText, unit === item.value && styles.segmentTextActive]}>
                    {item.label}
                  </Text>
                </Pressable>
              ))}
            </View>

            <View style={[styles.modeGrid, isLandscape && styles.modeGridLandscape]}>
              <Pressable
                accessibilityRole="button"
                onPress={() => selectMode('auto')}
                style={({ pressed }) => [
                  styles.modeButton,
                  styles.modeButtonPrimary,
                  isLandscape && styles.modeButtonLandscape,
                  mode === 'auto' && styles.modeButtonActive,
                  pressed && styles.pressed,
                ]}>
                <MaterialCommunityIcons
                  name="axis-arrow"
                  size={22}
                  color={mode === 'auto' ? '#000000' : '#FFFFFF'}
                />
                <Text style={[styles.modeText, mode === 'auto' && styles.modeTextActive]}>
                  Auto
                </Text>
              </Pressable>

              <View style={[styles.modeSecondaryRow, isLandscape && styles.modeSecondaryRowLandscape]}>
                {MODES.filter((item) => item.value !== 'auto').map((item) => (
                  <Pressable
                    accessibilityRole="button"
                    key={item.value}
                    onPress={() => selectMode(item.value)}
                    style={({ pressed }) => [
                      styles.modeButton,
                      styles.modeButtonSecondary,
                      isLandscape && styles.modeButtonLandscape,
                      mode === item.value && styles.modeButtonActive,
                      pressed && styles.pressed,
                    ]}>
                    <MaterialCommunityIcons
                      name={item.icon}
                      size={22}
                      color={mode === item.value ? '#000000' : '#FFFFFF'}
                    />
                    <Text style={[styles.modeText, mode === item.value && styles.modeTextActive]}>
                      {item.label}
                    </Text>
                  </Pressable>
                ))}
              </View>
            </View>
          </View>
        </View>
      </View>

      {!isLandscape && (
        <Text
          style={[
            styles.dedicationText,
            styles.dedicationTextBottom,
            { bottom: Math.max(insets.bottom + 4, 10) },
          ]}>
          {'❤️ Nolan Tronowicz'}
        </Text>
      )}

      <Modal
        animationType="fade"
        onRequestClose={() => {
          closeHistory().catch(() => undefined);
        }}
        statusBarTranslucent
        transparent
        visible={historyVisible}>
        <View style={styles.historyModalOverlay}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close saved readings"
            onPress={() => {
              closeHistory().catch(() => undefined);
            }}
            style={styles.historyModalBackdrop}
          />
          <View style={[styles.historyModalCard, isLandscape && styles.historyModalCardLandscape]}>
            <View style={styles.historyModalHeader}>
              <View>
                <Text style={styles.historyTitle}>Saved readings</Text>
                <Text style={styles.historySubtitle}>
                  {history.length === 0
                    ? 'No saved readings yet'
                    : `${historyIndex + 1}-${visibleHistoryEnd} of ${history.length}`}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close saved readings"
                onPress={() => {
                  closeHistory().catch(() => undefined);
                }}
                style={({ pressed }) => [styles.modalCloseButton, pressed && styles.pressed]}>
                <MaterialCommunityIcons name="close" size={20} color="#FFFFFF" />
              </Pressable>
            </View>

            <View style={styles.historyHint}>
              <MaterialCommunityIcons name="information-outline" size={18} color="#FFFFFF" />
              <Text style={styles.historyHintText}>Hold steady for 3 seconds to save a reading.</Text>
            </View>

            <View style={styles.historyModalBody}>
              {visibleHistoryItems.length > 0 ? (
                <View style={[styles.historyCards, isLandscape && styles.historyCardsLandscape]}>
                  {visibleHistoryItems.map((item) => {
                    const historyFlatAngles = item.flatAngles
                      ? {
                        x: roundDisplayAngle(item.flatAngles.x, unit),
                        y: roundDisplayAngle(item.flatAngles.y, unit),
                      }
                      : null;
                    const historySecondary =
                      item.mode === 'flat' && historyFlatAngles
                        ? formatFlatAxisSummary(historyFlatAngles, unit)
                        : formatSecondary(item.angle, supportingUnit);

                    return (
                      <View key={item.id} style={[styles.historyCard, isLandscape && styles.historyCardLandscape]}>
                        <Text style={styles.historyCardValue}>{formatPrimary(item.angle, unit)}</Text>
                        <Text style={styles.historyCardSecondary}>{historySecondary}</Text>
                        <Text style={styles.historyCardMeta}>
                          {MODE_LABELS[item.mode]} · {item.time}
                        </Text>
                      </View>
                    );
                  })}
                </View>
              ) : (
                <Text style={styles.emptyText}>No saved readings yet.</Text>
              )}
            </View>

            <View style={styles.historyModalFooter}>
              <View style={styles.historyNavRow}>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Show newer readings"
                  disabled={history.length === 0 || !canShowNewerHistory}
                  onPress={() => setHistoryIndex((current) => Math.max(current - historyPageSize, 0))}
                  style={({ pressed }) => [
                    styles.historyNavButton,
                    (history.length === 0 || !canShowNewerHistory) && styles.historyNavButtonDisabled,
                    pressed && canShowNewerHistory && styles.pressed,
                  ]}>
                  <MaterialCommunityIcons name="chevron-left" size={20} color="#FFFFFF" />
                  <Text style={styles.historyNavText}>Newer</Text>
                </Pressable>

                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Show older readings"
                  disabled={history.length === 0 || !canShowOlderHistory}
                  onPress={() => setHistoryIndex((current) => Math.min(current + historyPageSize, maxHistoryStart))}
                  style={({ pressed }) => [
                    styles.historyNavButton,
                    (history.length === 0 || !canShowOlderHistory) && styles.historyNavButtonDisabled,
                    pressed && canShowOlderHistory && styles.pressed,
                  ]}>
                  <Text style={styles.historyNavText}>Older</Text>
                  <MaterialCommunityIcons name="chevron-right" size={20} color="#FFFFFF" />
                </Pressable>
              </View>

              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Clear saved readings"
                disabled={history.length === 0}
                onPress={clearHistory}
                style={({ pressed }) => [
                  styles.clearButton,
                  styles.historyClearButton,
                  history.length === 0 && styles.clearButtonDisabled,
                  pressed && history.length > 0 && styles.pressed,
                ]}>
                <Text style={[styles.clearText, history.length === 0 && styles.clearTextDisabled]}>
                  Clear
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000000',
  },
  content: {
    flex: 1,
    paddingBottom: 16,
    paddingTop: 12,
  },
  contentLandscape: {
    paddingBottom: 10,
    paddingTop: 6,
  },
  ruler: {
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 12,
    borderWidth: 1,
    overflow: 'hidden',
    position: 'absolute',
  },
  rulerVertical: {
    bottom: 0,
    top: 0,
    width: RULER_WIDTH,
  },
  rulerHorizontal: {
    height: RULER_WIDTH,
    left: 0,
    right: 0,
  },
  rulerLeft: {
    left: 6,
  },
  rulerRight: {
    right: 6,
  },
  rulerTop: {
    top: 6,
  },
  rulerBottom: {
    bottom: 6,
  },
  rulerEdge: {
    backgroundColor: '#FFFFFF',
    opacity: 0.92,
    position: 'absolute',
  },
  rulerEdgeLeft: {
    bottom: 0,
    right: 0,
    top: 0,
    width: 1,
  },
  rulerEdgeRight: {
    bottom: 0,
    left: 0,
    top: 0,
    width: 1,
  },
  rulerEdgeTop: {
    bottom: 0,
    height: 1,
    left: 0,
    right: 0,
  },
  rulerEdgeBottom: {
    height: 1,
    left: 0,
    right: 0,
    top: 0,
  },
  rulerTrack: {
    position: 'absolute',
  },
  rulerTrackVertical: {
    left: 0,
    right: 0,
    top: 0,
  },
  rulerTrackHorizontal: {
    bottom: 0,
    left: 0,
    top: 0,
  },
  rulerTick: {
    backgroundColor: '#FFFFFF',
    position: 'absolute',
  },
  rulerTickVertical: {
    height: 1,
  },
  rulerTickHorizontal: {
    width: 1,
  },
  rulerTickLeft: {
    right: 0,
  },
  rulerTickRight: {
    left: 0,
  },
  rulerTickTop: {
    bottom: 0,
  },
  rulerTickBottom: {
    top: 0,
  },
  rulerTickShort: {
    width: 7,
  },
  rulerTickMedium: {
    width: 12,
  },
  rulerTickLong: {
    width: 18,
  },
  rulerTickShortHorizontal: {
    height: 7,
  },
  rulerTickMediumHorizontal: {
    height: 12,
  },
  rulerTickLongHorizontal: {
    height: 18,
  },
  rulerLabel: {
    backgroundColor: '#07090B',
    borderRadius: 4,
    color: '#FFFFFF',
    elevation: 1,
    fontSize: 9,
    fontVariant: ['tabular-nums'],
    lineHeight: 10,
    opacity: 0.8,
    paddingHorizontal: 2,
    position: 'absolute',
    width: RULER_LABEL_WIDTH,
    zIndex: 1,
  },
  rulerLabelLeft: {
    left: 3,
    textAlign: 'left',
  },
  rulerLabelRight: {
    right: 3,
    textAlign: 'right',
  },
  rulerLabelTop: {
    bottom: 6,
    textAlign: 'center',
  },
  rulerLabelBottom: {
    textAlign: 'center',
    top: 6,
  },
  rulerUnitBadge: {
    backgroundColor: '#FFFFFF',
    borderRadius: 8,
    paddingHorizontal: 6,
    paddingVertical: 3,
    position: 'absolute',
  },
  rulerUnitBadgeLeft: {
    bottom: 10,
    left: 4,
  },
  rulerUnitBadgeRight: {
    bottom: 10,
    right: 4,
  },
  rulerUnitBadgeTop: {
    right: 10,
    top: 4,
  },
  rulerUnitBadgeBottom: {
    bottom: 4,
    right: 10,
  },
  rulerUnitText: {
    color: '#000000',
    fontSize: 10,
    fontWeight: '900',
    textTransform: 'uppercase',
  },
  rulerGrabHandle: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    justifyContent: 'center',
    position: 'absolute',
  },
  rulerGrabHandlePortrait: {
    borderRadius: 17,
    height: RULER_HANDLE_HEIGHT,
    right: 3,
    width: RULER_WIDTH + 6,
  },
  rulerGrabHandleLandscape: {
    borderRadius: 20,
    bottom: 3,
    height: RULER_WIDTH + 6,
    width: RULER_HANDLE_WIDTH,
  },
  header: {
    alignItems: 'center',
    flexDirection: 'row',
    justifyContent: 'space-between',
    marginBottom: 16,
  },
  headerLandscape: {
    marginBottom: 6,
  },
  headerActions: {
    flexDirection: 'row',
    gap: 10,
  },
  headerActionsLandscape: {
    gap: 8,
  },
  mainArea: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  mainAreaLandscape: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'center',
  },
  gaugeColumn: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  controlsColumn: {
    alignSelf: 'stretch',
    justifyContent: 'center',
  },
  controlsColumnLandscape: {
    flex: 1,
    maxWidth: 380,
  },
  kicker: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '700',
    opacity: 0.72,
    textTransform: 'uppercase',
  },
  title: {
    color: '#FFFFFF',
    fontSize: 32,
    fontWeight: '800',
  },
  titleLandscape: {
    fontSize: 22,
  },
  dedicationText: {
    color: '#FFFFFF',
    fontSize: 9,
    fontWeight: '700',
    opacity: 0.7,
  },
  dedicationTextBottom: {
    left: 0,
    position: 'absolute',
    right: 0,
    textAlign: 'center',
  },
  iconButton: {
    alignItems: 'center',
    borderColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    height: 44,
    justifyContent: 'center',
    position: 'relative',
    width: 44,
  },
  iconButtonLandscape: {
    height: 34,
    width: 34,
  },
  historyBadge: {
    alignItems: 'center',
    backgroundColor: '#FFFFFF',
    borderRadius: 10,
    justifyContent: 'center',
    minWidth: 20,
    paddingHorizontal: 5,
    position: 'absolute',
    right: -7,
    top: -7,
  },
  historyBadgeText: {
    color: '#000000',
    fontSize: 11,
    fontWeight: '900',
  },
  gauge: {
    alignItems: 'center',
    alignSelf: 'center',
    borderRadius: 8,
    borderWidth: 2,
    justifyContent: 'center',
    overflow: 'hidden',
  },
  crosshairVertical: {
    bottom: 0,
    opacity: 0.34,
    position: 'absolute',
    top: 0,
    width: 1,
  },
  crosshairHorizontal: {
    height: 1,
    left: 0,
    opacity: 0.34,
    position: 'absolute',
    right: 0,
  },
  centerRing: {
    borderRadius: 42,
    borderWidth: 2,
    height: 84,
    opacity: 0.8,
    position: 'absolute',
    width: 84,
  },
  rail: {
    opacity: 0.86,
    position: 'absolute',
  },
  railHorizontal: {
    height: 3,
    left: 22,
    right: 22,
  },
  railVertical: {
    bottom: 22,
    top: 22,
    width: 3,
  },
  railCenter: {
    borderRadius: 34,
    borderWidth: 2,
    height: 68,
    opacity: 0.8,
    position: 'absolute',
    width: 68,
  },
  bubble: {
    backgroundColor: '#FFFFFF',
    borderRadius: 28,
    height: 56,
    position: 'absolute',
    width: 56,
  },
  bubbleLevel: {
    borderColor: '#0A1302',
    borderWidth: 8,
  },
  readout: {
    alignItems: 'center',
    marginTop: 18,
  },
  readoutLandscape: {
    marginTop: 0,
  },
  degreeText: {
    color: '#FFFFFF',
    fontSize: 60,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
    includeFontPadding: false,
  },
  degreeTextLandscape: {
    fontSize: 46,
  },
  secondaryText: {
    color: '#FFFFFF',
    fontSize: 20,
    fontWeight: '700',
  },
  statusText: {
    color: '#FFFFFF',
    fontSize: 13,
    marginTop: 6,
    opacity: 0.72,
  },
  segmentGroup: {
    borderColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    marginTop: 18,
    overflow: 'hidden',
  },
  segmentGroupLandscape: {
    marginTop: 10,
  },
  segment: {
    alignItems: 'center',
    flex: 1,
    minHeight: 42,
    justifyContent: 'center',
  },
  segmentLandscape: {
    minHeight: 34,
  },
  segmentActive: {
    backgroundColor: '#FFFFFF',
  },
  segmentText: {
    color: '#FFFFFF',
    fontSize: 15,
    fontWeight: '800',
  },
  segmentTextActive: {
    color: '#000000',
  },
  modeGrid: {
    gap: 8,
    marginTop: 12,
  },
  modeGridLandscape: {
    gap: 6,
    marginTop: 8,
  },
  modeSecondaryRow: {
    flexDirection: 'row',
    gap: 8,
  },
  modeSecondaryRowLandscape: {
    gap: 6,
  },
  modeButton: {
    alignItems: 'center',
    borderColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    flexDirection: 'row',
    gap: 8,
    minHeight: 46,
    justifyContent: 'center',
  },
  modeButtonPrimary: {
    width: '100%',
  },
  modeButtonSecondary: {
    flex: 1,
  },
  modeButtonLandscape: {
    minHeight: 36,
  },
  modeButtonActive: {
    backgroundColor: '#FFFFFF',
  },
  modeText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  modeTextActive: {
    color: '#000000',
  },
  historyTitle: {
    color: '#FFFFFF',
    fontSize: 19,
    fontWeight: '900',
  },
  clearButton: {
    borderColor: '#FFFFFF',
    borderRadius: 8,
    borderWidth: 1,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  clearButtonDisabled: {
    opacity: 0.28,
  },
  clearText: {
    color: '#FFFFFF',
    fontSize: 13,
    fontWeight: '800',
  },
  clearTextDisabled: {
    opacity: 0.72,
  },
  historySubtitle: {
    color: 'rgba(255, 255, 255, 0.58)',
    fontSize: 13,
    fontWeight: '700',
    marginTop: 4,
  },
  historyModalOverlay: {
    alignItems: 'center',
    backgroundColor: 'rgba(0, 0, 0, 0.82)',
    flex: 1,
    justifyContent: 'center',
    padding: 20,
  },
  historyModalBackdrop: {
    ...StyleSheet.absoluteFillObject,
  },
  historyModalCard: {
    alignSelf: 'center',
    backgroundColor: '#090A0C',
    borderColor: 'rgba(255, 255, 255, 0.16)',
    borderRadius: 24,
    borderWidth: 1,
    maxWidth: 560,
    padding: 22,
    shadowColor: '#000000',
    shadowOffset: { width: 0, height: 18 },
    shadowOpacity: 0.42,
    shadowRadius: 28,
    width: '100%',
  },
  historyModalCardLandscape: {
    maxWidth: 640,
  },
  historyModalHeader: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    justifyContent: 'space-between',
  },
  historyHint: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 10,
    marginTop: 16,
    paddingHorizontal: 14,
    paddingVertical: 13,
  },
  historyHintText: {
    color: '#FFFFFF',
    flex: 1,
    fontSize: 13,
    fontWeight: '700',
    lineHeight: 18,
  },
  modalCloseButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.05)',
    borderRadius: 14,
    height: 44,
    justifyContent: 'center',
    width: 44,
  },
  historyModalBody: {
    alignItems: 'stretch',
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    borderRadius: 20,
    justifyContent: 'center',
    marginTop: 16,
    minHeight: 292,
    padding: 14,
  },
  historyCards: {
    gap: 12,
  },
  historyCardsLandscape: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  historyCard: {
    backgroundColor: '#101214',
    borderColor: 'rgba(255, 255, 255, 0.08)',
    borderRadius: 18,
    borderWidth: 1,
    minHeight: 74,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  historyCardLandscape: {
    width: '48.5%',
  },
  historyCardValue: {
    color: '#FFFFFF',
    fontSize: 26,
    fontVariant: ['tabular-nums'],
    fontWeight: '900',
  },
  historyCardSecondary: {
    color: 'rgba(255, 255, 255, 0.88)',
    fontSize: 14,
    fontWeight: '700',
    marginTop: 6,
  },
  historyCardMeta: {
    color: 'rgba(255, 255, 255, 0.5)',
    fontSize: 12,
    fontWeight: '700',
    marginTop: 10,
  },
  historyModalFooter: {
    gap: 10,
    marginTop: 18,
  },
  historyNavRow: {
    flexDirection: 'row',
    gap: 10,
  },
  historyNavButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.06)',
    borderRadius: 16,
    flex: 1,
    flexDirection: 'row',
    gap: 6,
    justifyContent: 'center',
    minHeight: 48,
  },
  historyNavButtonDisabled: {
    backgroundColor: 'rgba(255, 255, 255, 0.03)',
    opacity: 0.38,
  },
  historyNavText: {
    color: '#FFFFFF',
    fontSize: 14,
    fontWeight: '800',
  },
  historyClearButton: {
    alignItems: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.04)',
    borderWidth: 0,
    borderRadius: 16,
    justifyContent: 'center',
    minHeight: 46,
  },
  emptyText: {
    color: 'rgba(255, 255, 255, 0.72)',
    fontSize: 14,
    lineHeight: 20,
    maxWidth: 240,
    textAlign: 'center',
  },
  pressed: {
    opacity: 0.62,
  },
});
