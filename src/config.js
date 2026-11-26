// SetTheCue — central config.
// The app name lives here so renaming later is a one-line change.

export const APP_NAME = "SetTheCue";

// AbletonOSC networking.
// AbletonOSC listens for commands on 11000 and sends replies/updates to 11001.
// These are AbletonOSC's defaults; only change them if you've reconfigured it.
export const OSC = {
  host: "127.0.0.1",
  remotePort: 11000, // we send commands here (AbletonOSC's listen port)
  localPort: 11001, // we listen here (AbletonOSC's reply port)
};

// Nama band pertama. Dipakai sekali saat data lama (setlist, lirik, mixer, target waktu)
// dipindahkan ke profil band. Setelah itu band dikelola dari aplikasi.
export const FIRST_BAND_NAME = "Los Ra Ricos";
