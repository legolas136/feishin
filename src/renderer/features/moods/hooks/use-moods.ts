import { useQueries, useQuery } from '@tanstack/react-query';
import { useMemo } from 'react';

import { sharedQueries } from '/@/renderer/features/shared/api/shared-api';
import { songsQueries } from '/@/renderer/features/songs/api/songs-api';
import { useCurrentServerId } from '/@/renderer/store';
import { LibraryItem, SongListSort, SortOrder } from '/@/shared/types/domain-types';

export type Mood = { id: string; name: string; songCount: null | number };

const HOUR = 1000 * 60 * 60;

// Navidrome only keeps tag counts for genres, so mood song counts are fetched per mood
export const useMoods = () => {
    const serverId = useCurrentServerId();

    const tagListQuery = useQuery(
        sharedQueries.tagList({
            options: { gcTime: HOUR, staleTime: HOUR },
            query: { type: LibraryItem.SONG },
            serverId,
        }),
    );

    const options = useMemo(
        () => tagListQuery.data?.tags?.find((tag) => tag.name === 'mood')?.options ?? [],
        [tagListQuery.data?.tags],
    );

    const countData = useQueries({
        combine: (results) => results.map((result) => result.data),
        queries: options.map((option) =>
            songsQueries.listCount({
                options: { gcTime: HOUR, staleTime: HOUR },
                query: {
                    _custom: { mood: [option.id] },
                    sortBy: SongListSort.NAME,
                    sortOrder: SortOrder.ASC,
                },
                serverId,
            }),
        ),
    });

    const moods: Mood[] = useMemo(
        () =>
            options.map((option, index) => ({
                id: option.id,
                name: option.name,
                songCount: option.songCount || (countData[index] ?? null),
            })),
        [options, countData],
    );

    return { isLoading: tagListQuery.isLoading, moods };
};
