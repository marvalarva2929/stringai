import { create } from 'zustand';
import { persist, createJSONStorage, StateStorage } from 'zustand/middleware';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { scheduleDailyReminder, cancelReminders } from '../lib/notifications';

const safeStorage: StateStorage = {
  getItem: (name) => AsyncStorage.getItem(name).catch(() => null),
  setItem: (name, value) => AsyncStorage.setItem(name, value).catch(() => {}),
  removeItem: (name) => AsyncStorage.removeItem(name).catch(() => {}),
};

interface ReminderState {
  enabled: boolean;
  hour: number;
  minute: number;

  /** Schedules the OS notification, then persists — store and OS schedule
   *  never drift because the schedule call always runs first. */
  enable: (hour: number, minute: number) => Promise<void>;
  disable: () => Promise<void>;
}

export const useReminderStore = create<ReminderState>()(
  persist(
    (set) => ({
      enabled: false,
      hour: 18,
      minute: 0,

      enable: async (hour, minute) => {
        await scheduleDailyReminder(hour, minute);
        set({ enabled: true, hour, minute });
      },

      disable: async () => {
        await cancelReminders();
        set({ enabled: false });
      },
    }),
    {
      name: 'stringai-reminders-v1',
      storage: createJSONStorage(() => safeStorage),
      version: 1,
    }
  )
);
