export interface DlnaDevice {
    controlUrl: string;
    groupCoordinatorId?: string;
    groupMembers?: DlnaDevice[];
    id: string;
    isPair?: boolean;
    location: string;
    name: string;
    renderingControlUrl: string;
}

// Chromecasts are listed with a cast://host:port control URL (see the main cast target).
export const isCastDevice = (device?: null | { controlUrl?: string }) =>
    !!device?.controlUrl?.startsWith('cast://');

export interface GroupMember {
    device: DlnaDevice;
    isCoordinator: boolean;
    volume: number;
}
