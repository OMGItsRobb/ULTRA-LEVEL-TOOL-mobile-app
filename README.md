# Ultra Level Tool

Ultra Level Tool is a mobile level and inclinometer built with Expo and React Native for iOS and Android. It uses device motion sensors to provide live leveling feedback, a flat-surface bubble interface, edge measurements, saved readings, and built-in rulers for quick reference on a phone.

<img width="2004" height="878" alt="image" src="https://github.com/user-attachments/assets/cda822d7-807a-4cd0-a30f-514cc092a788" />


# Disclosure

This app was updated from Expo v44 to v54, and may not work exactly as intended on v54

## Highlights

- Mobile-first level tool for iOS and Android
- Auto, Flat, and Edge measurement modes
- Readouts in degrees, percent grade, and rise-over-run
- Flat mode bubble level with separate X and Y axis values
- Audio and haptic feedback for level detection and saved readings
- Local saved-reading history with timestamped entries
- Draggable on-screen rulers in inches and centimeters
- Portrait and landscape layouts optimized for handheld use

## Platform Scope

- This project is intended for iOS and Android only
- A physical device is strongly recommended because motion sensors are limited or unavailable in simulators and emulators
- Web is not a target platform for this app
- The app does not require a backend, user accounts, or cloud services

## Tech Stack

- Expo SDK 54
- React Native 0.81
- React 19
- TypeScript
- Expo Router
- Expo Sensors for motion data
- Expo Screen Orientation for mode-specific orientation behavior
- Expo Haptics and Expo Audio for feedback cues
- AsyncStorage for on-device reading history

## Features

### Measurement modes

- Auto mode switches between flat and edge behavior based on device position
- Flat mode behaves like a bubble level and shows X and Y tilt independently
- Edge mode provides a single-axis roll reading for side measurements

### Readout units

- Degrees for direct angle measurement
- Percent grade for slope work
- Rise-over-run for construction-style readings

### Saved readings

- Readings are captured after the device stays stable for 3 seconds
- Each saved reading includes the measurement mode and a timestamp
- History is stored locally on the device

## Getting Started

### Prerequisites

- Node.js LTS
- npm
- Expo Go or a development build for on-device testing
- Optional: Android Studio or Xcode for emulator and simulator setup

### Install dependencies

```bash
npm install
```

### Start the app

```bash
npm run start
```

From the Expo CLI you can:

- open Android
- open iOS
- scan the QR code with Expo Go on a physical device

For realistic sensor behavior, test on a real phone.

### Useful scripts

```bash
npm run start
npm run android
npm run ios
npm run lint
```

## Project Structure

```text
app/
   _layout.tsx    Expo Router layout
   index.tsx      Main level tool screen and interaction logic
assets/
   images/        Icons and splash assets
   sounds/        Audio feedback cues
scripts/
   reset-project.js
```

## Privacy and Data

- Saved readings stay on the device through AsyncStorage
- The app does not upload readings to a remote server
- The app does not include sign-in, analytics, or cloud sync in this repository

## Development Notes

- The main application logic currently lives in app/index.tsx
- Motion-driven features depend on device sensors and are best verified on hardware
- Flat mode locks the screen to portrait to keep the interaction consistent while measuring on a surface

## Contributing

Issues and pull requests are welcome for bug fixes, measurement accuracy improvements, UI refinements, and platform polish.

If you open a change, include:

- the device and OS version used for testing
- whether the issue appears in flat mode, edge mode, or both
- a short reproduction note when reporting sensor or orientation issues
