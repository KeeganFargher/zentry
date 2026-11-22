// The app's entry. The background tasks are defined before Expo Router loads
// the app: when Android starts the JavaScript runtime for a push or a
// scheduled refresh, the task it was started for must already exist.
import "./src/lib/background";
import "expo-router/entry";
