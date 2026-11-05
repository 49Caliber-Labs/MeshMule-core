export interface FisheryLocation {
  id: string;
  name: string;
  region: string;
  state?: string;
  coordinates: {
    lat: number;
    lng: number;
  };
  usgsStationId?: string;
  waterTemp: number;
  flowRate?: string;
  barometerHpa?: number;
  barometer3hDelta?: number;
  elevationMeters?: number;
}
