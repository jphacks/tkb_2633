export type EntityId = string;
export type LocalDate = `${number}-${number}-${number}`;
export type ISODateTime = string;

export interface GeoCoordinates {
  latitude: number;
  longitude: number;
}

/** Monday = 1 through Sunday = 7, independent of the device locale. */
export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export interface Household {
  id: EntityId;
  name: string;
  createdAt: ISODateTime;
}

export interface HouseholdMember {
  id: EntityId;
  householdId: EntityId;
  displayName: string;
}
