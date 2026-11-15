import { useMemo } from 'react';

import styles from './genre-badge-column.module.css';

import {
    ColumnNullFallback,
    ColumnSkeletonVariable,
    ItemTableListInnerColumn,
    TableColumnContainer,
} from '/@/renderer/components/item-list/item-table-list/item-table-list-column';
import { Badge } from '/@/shared/components/badge/badge';
import { Group } from '/@/shared/components/group/group';
import { stringToColor } from '/@/shared/utils/string-to-color';

const MAX_MOODS = 4;

const MoodBadgeColumn = (props: ItemTableListInnerColumn) => {
    const rowItem = props.getRowItem?.(props.rowIndex) ?? (props.data as any[])[props.rowIndex];
    const tags: null | Record<string, string[]> | undefined = (rowItem as any)?.tags;

    const moods = useMemo(
        () =>
            (tags?.mood ?? []).slice(0, MAX_MOODS).map((name) => ({
                name,
                ...stringToColor(name),
            })),
        [tags],
    );

    if (rowItem === undefined) {
        return <ColumnSkeletonVariable {...props} />;
    }

    if (moods.length === 0) {
        return <ColumnNullFallback {...props} />;
    }

    return (
        <TableColumnContainer {...props}>
            <Group className={styles.group} wrap="wrap">
                {moods.map((mood) => (
                    <Badge
                        key={mood.name}
                        style={{
                            backgroundColor: mood.color,
                            color: mood.isLight ? 'black' : 'white',
                        }}
                    >
                        {mood.name}
                    </Badge>
                ))}
            </Group>
        </TableColumnContainer>
    );
};

export { MoodBadgeColumn };
