// The issue list's filters, laid out as Sentry's issue stream: a search
// field, a joined bar of dropdowns (project, status, level), and the sort on
// the table header. They live in the screen's state; a push that opens a
// project's issues sets the project.

import type { ApiProject, Level } from "@contract";
import { useState } from "react";
import type { JSX } from "react";
import { Modal, Pressable, ScrollView, TextInput, View } from "react-native";

import { Button, ButtonBar, joinAt } from "~/components/button";
import { Icon } from "~/components/icons";
import { SectionTitle, Text } from "~/components/text";
import { usePalette } from "~/lib/preferences";
import { CONTROL, FONTS, RADIUS, SPACE } from "~/lib/theme";

export type StatusFilter = "unresolved" | "resolved" | "ignored" | "all";

export type SortOrder = "date" | "new" | "freq";

export type Filters = {
  status: StatusFilter;
  /** A level, or null for every level. */
  level: Level | null;
  sort: SortOrder;
  /** A project id, or null for every project. */
  project: number | null;
  query: string;
};

export type Choice<T> = { value: T; label: string };

export const LEVELS: Choice<Level | null>[] = [
  { value: null, label: "All Levels" },
  { value: "fatal", label: "Fatal" },
  { value: "error", label: "Error" },
  { value: "warning", label: "Warning" },
  { value: "info", label: "Info" },
  { value: "debug", label: "Debug" },
];

export const DEFAULT_FILTERS: Filters = {
  status: "unresolved",
  level: null,
  sort: "date",
  project: null,
  query: "",
};

export const STATUSES: Choice<StatusFilter>[] = [
  { value: "unresolved", label: "Unresolved" },
  { value: "resolved", label: "Resolved" },
  { value: "ignored", label: "Archived" },
  { value: "all", label: "All Statuses" },
];

const SORTS: Choice<SortOrder>[] = [
  { value: "date", label: "Last Seen" },
  { value: "new", label: "First Seen" },
  { value: "freq", label: "Events" },
];

/** The list's query string, in the API's parameter names. */
export function filterQuery(filters: Filters): URLSearchParams {
  const query = new URLSearchParams({ status: filters.status, sort: filters.sort });

  if (filters.project !== null) {
    query.set("project", String(filters.project));
  }

  if (filters.level !== null) {
    query.set("level", filters.level);
  }

  if (filters.query.trim() !== "") {
    query.set("query", filters.query.trim());
  }

  return query;
}

type SheetProps<T> = {
  title: string;
  choices: Choice<T>[];
  value: T;
  onChange: (value: T) => void;
  onClose: () => void;
};

/** The choices, as a sheet from the bottom of the screen. */
function Sheet<T>({ title, choices, value, onChange, onClose }: SheetProps<T>): JSX.Element {
  const palette = usePalette();

  return (
    <Modal transparent visible animationType="fade" onRequestClose={onClose}>
      <Pressable
        style={{ flex: 1, backgroundColor: "rgba(0,0,0,0.4)", justifyContent: "flex-end" }}
        onPress={onClose}
      >
        <View
          style={{
            backgroundColor: palette.bg,
            borderTopLeftRadius: RADIUS.lg,
            borderTopRightRadius: RADIUS.lg,
            maxHeight: "70%",
            paddingBottom: SPACE.lg,
          }}
        >
          <View style={{ padding: SPACE.lg }}>
            <SectionTitle>{title}</SectionTitle>
          </View>
          <ScrollView>
            {choices.map((choice) => (
              <Pressable
                key={choice.label}
                accessibilityRole="button"
                accessibilityState={{ selected: choice.value === value }}
                onPress={() => {
                  onChange(choice.value);
                  onClose();
                }}
                style={({ pressed }) => ({
                  minHeight: CONTROL.touch,
                  paddingHorizontal: SPACE.lg,
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "space-between",
                  backgroundColor: pressed ? palette.raised : palette.bg,
                })}
              >
                <Text
                  weight={choice.value === value ? "medium" : "regular"}
                  tone={choice.value === value ? "link" : "text"}
                >
                  {choice.label}
                </Text>
                {choice.value === value && <Icon name="check" color={palette.link} />}
              </Pressable>
            ))}
          </ScrollView>
        </View>
      </Pressable>
    </Modal>
  );
}

type PickerProps<T> = Omit<SheetProps<T>, "onClose"> & { index: number; count: number };

/** One dropdown of the joined bar; it opens a sheet of its choices. */
function Picker<T>(props: PickerProps<T>): JSX.Element {
  const [open, setOpen] = useState(false);
  // A push can filter by a project before the project list has loaded; until
  // it has, the dropdown can only say what it filters.
  const current = props.choices.find((choice) => choice.value === props.value);

  return (
    <>
      <Button
        label={current?.label ?? props.title}
        chevron
        grow
        join={joinAt(props.index, props.count)}
        onPress={() => setOpen(true)}
      />
      {open && <Sheet {...props} onClose={() => setOpen(false)} />}
    </>
  );
}

/** Searches when the keyboard's search key is pressed or the field is left. */
function SearchField({
  query,
  onSearch,
}: {
  query: string;
  onSearch: (query: string) => void;
}): JSX.Element {
  const palette = usePalette();
  const [text, setText] = useState(query);

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        gap: SPACE.sm,
        height: CONTROL.touch,
        backgroundColor: palette.bg,
        borderColor: palette.border,
        borderWidth: 1,
        borderRadius: RADIUS.md,
        paddingHorizontal: SPACE.md,
      }}
    >
      <Icon name="search" />
      <TextInput
        value={text}
        onChangeText={setText}
        onSubmitEditing={() => onSearch(text)}
        onBlur={() => onSearch(text)}
        placeholder="Search issues"
        placeholderTextColor={palette.faint}
        accessibilityLabel="Search issue titles and culprits"
        returnKeyType="search"
        style={{
          flex: 1,
          height: CONTROL.touch,
          color: palette.text,
          fontFamily: FONTS.regular,
          fontSize: 14,
        }}
      />
    </View>
  );
}

type FilterBarProps = {
  organization: string;
  filters: Filters;
  projects: ApiProject[];
  onChange: (filters: Filters) => void;
};

/** The page header: title, search, and the dropdown bar. */
export function FilterBar({
  organization,
  filters,
  projects,
  onChange,
}: FilterBarProps): JSX.Element {
  const projectChoices: Choice<number | null>[] = [
    { value: null, label: "All Projects" },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];

  return (
    <View style={{ gap: SPACE.md, paddingHorizontal: SPACE.lg, paddingBottom: SPACE.md }}>
      <View>
        <Text size={12} tone="muted" lines={1}>
          {organization}
        </Text>
        <Text size={24} weight="medium" tone="heading">
          Issues
        </Text>
      </View>
      <SearchField query={filters.query} onSearch={(query) => onChange({ ...filters, query })} />
      <ButtonBar>
        <Picker
          title="Project"
          index={0}
          count={3}
          value={filters.project}
          choices={projectChoices}
          onChange={(project) => onChange({ ...filters, project })}
        />
        <Picker
          title="Status"
          index={1}
          count={3}
          value={filters.status}
          choices={STATUSES}
          onChange={(status) => onChange({ ...filters, status })}
        />
        <Picker
          title="Level"
          index={2}
          count={3}
          value={filters.level}
          choices={LEVELS}
          onChange={(level) => onChange({ ...filters, level })}
        />
      </ButtonBar>
    </View>
  );
}

/** The table header over the rows; its right side is the sort, as on Sentry. */
export function ListHeader({
  sort,
  onSort,
}: {
  sort: SortOrder;
  onSort: (sort: SortOrder) => void;
}): JSX.Element {
  const palette = usePalette();
  const [open, setOpen] = useState(false);
  const current = SORTS.find((choice) => choice.value === sort);

  if (current === undefined) {
    throw new Error(`No sort called ${sort}`);
  }

  return (
    <View
      style={{
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "space-between",
        // A touch target's height: the sort lives in this header.
        height: CONTROL.touch,
        paddingLeft: SPACE.lg,
        backgroundColor: palette.surface,
        borderColor: palette.borderSoft,
        borderTopWidth: 1,
        borderBottomWidth: 1,
      }}
    >
      <SectionTitle>Issue</SectionTitle>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Sorted by ${current.label}. Change sort`}
        onPress={() => setOpen(true)}
        style={{
          flexDirection: "row",
          alignItems: "center",
          gap: 4,
          height: CONTROL.touch,
          paddingHorizontal: SPACE.lg,
        }}
      >
        <SectionTitle>{current.label}</SectionTitle>
        <Icon name="sortDown" size={12} />
      </Pressable>
      {open && (
        <Sheet
          title="Sort by"
          choices={SORTS}
          value={sort}
          onChange={onSort}
          onClose={() => setOpen(false)}
        />
      )}
    </View>
  );
}
