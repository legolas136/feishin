import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Link, useNavigate } from 'react-router';

import styles from './mood-list-route.module.css';

import { PageHeader } from '/@/renderer/components/page-header/page-header';
import { useMoods } from '/@/renderer/features/moods/hooks/use-moods';
import { AnimatedPage } from '/@/renderer/features/shared/components/animated-page';
import { FilterBar } from '/@/renderer/features/shared/components/filter-bar';
import { LibraryHeaderBar } from '/@/renderer/features/shared/components/library-header-bar';
import { ListSearchInput } from '/@/renderer/features/shared/components/list-search-input';
import { PageErrorBoundary } from '/@/renderer/features/shared/components/page-error-boundary';
import { useSearchTermFilter } from '/@/renderer/features/shared/hooks/use-search-term-filter';
import { FILTER_KEYS } from '/@/renderer/features/shared/utils';
import { AppRoute } from '/@/renderer/router/routes';
import { Badge } from '/@/shared/components/badge/badge';
import { Group } from '/@/shared/components/group/group';
import { SegmentedControl } from '/@/shared/components/segmented-control/segmented-control';
import { Spinner } from '/@/shared/components/spinner/spinner';
import { Stack } from '/@/shared/components/stack/stack';
import { Table } from '/@/shared/components/table/table';
import { Text } from '/@/shared/components/text/text';
import { useLocalStorage } from '/@/shared/hooks/use-local-storage';
import { stringToColor } from '/@/shared/utils/string-to-color';

const getMoodTracksPath = (moodId: string) =>
    `${AppRoute.LIBRARY_SONGS}?${FILTER_KEYS.SONG._CUSTOM}=${encodeURIComponent(
        JSON.stringify({ mood: [moodId] }),
    )}`;

const MoodListRoute = () => {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const { isLoading, moods } = useMoods();
    const { searchTerm } = useSearchTermFilter();
    const [display, setDisplay] = useLocalStorage<'grid' | 'table'>({
        defaultValue: 'grid',
        key: 'mood-list-display',
    });

    const items = useMemo(() => {
        const term = searchTerm?.trim().toLowerCase();
        return moods
            .filter((mood) => !term || mood.name.toLowerCase().includes(term))
            .map((mood) => ({ ...mood, ...stringToColor(mood.name) }));
    }, [moods, searchTerm]);

    const songCountLabel = (count: null | number) =>
        count === null ? '' : `${count} ${t('entity.song', { count })}`;

    return (
        <AnimatedPage>
            <Stack gap={0} h="100%">
                <PageHeader>
                    <LibraryHeaderBar ignoreMaxWidth>
                        <LibraryHeaderBar.Title>{t('page.moodList.title')}</LibraryHeaderBar.Title>
                        <LibraryHeaderBar.Badge isLoading={isLoading}>
                            {items.length}
                        </LibraryHeaderBar.Badge>
                    </LibraryHeaderBar>
                    <Group>
                        <ListSearchInput />
                    </Group>
                </PageHeader>
                <FilterBar>
                    <Group justify="flex-end">
                        <SegmentedControl
                            data={[
                                { label: t('table.config.view.grid'), value: 'grid' },
                                { label: t('table.config.view.table'), value: 'table' },
                            ]}
                            onChange={(value) => setDisplay(value as 'grid' | 'table')}
                            size="xs"
                            value={display}
                        />
                    </Group>
                </FilterBar>
                <div className={styles.content}>
                    {isLoading ? (
                        <Spinner container />
                    ) : display === 'grid' ? (
                        <div className={styles.grid}>
                            {items.map((mood) => (
                                <Link
                                    className={styles.card}
                                    key={mood.id}
                                    style={{
                                        backgroundColor: mood.color,
                                        color: mood.isLight ? 'black' : 'white',
                                    }}
                                    to={getMoodTracksPath(mood.id)}
                                >
                                    <Text fw={600} size="lg" style={{ color: 'inherit' }}>
                                        {mood.name}
                                    </Text>
                                    <Text size="xs" style={{ color: 'inherit', opacity: 0.8 }}>
                                        {songCountLabel(mood.songCount)}
                                    </Text>
                                </Link>
                            ))}
                        </div>
                    ) : (
                        <Table highlightOnHover>
                            <Table.Thead>
                                <Table.Tr>
                                    <Table.Th>{t('filter.mood')}</Table.Th>
                                    <Table.Th>{t('entity.track', { count: 2 })}</Table.Th>
                                </Table.Tr>
                            </Table.Thead>
                            <Table.Tbody>
                                {items.map((mood) => (
                                    <Table.Tr
                                        className={styles.row}
                                        key={mood.id}
                                        onClick={() => navigate(getMoodTracksPath(mood.id))}
                                    >
                                        <Table.Td>
                                            <Badge
                                                style={{
                                                    backgroundColor: mood.color,
                                                    color: mood.isLight ? 'black' : 'white',
                                                }}
                                            >
                                                {mood.name}
                                            </Badge>
                                        </Table.Td>
                                        <Table.Td>{mood.songCount ?? ''}</Table.Td>
                                    </Table.Tr>
                                ))}
                            </Table.Tbody>
                        </Table>
                    )}
                </div>
            </Stack>
        </AnimatedPage>
    );
};

const MoodListRouteWithBoundary = () => (
    <PageErrorBoundary>
        <MoodListRoute />
    </PageErrorBoundary>
);

export default MoodListRouteWithBoundary;
