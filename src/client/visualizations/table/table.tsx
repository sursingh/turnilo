/*
 * Copyright 2015-2016 Imply Data, Inc.
 * Copyright 2017-2019 Allegro.pl
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as d3 from "d3";
import { Dataset, Datum, PseudoDatum } from "plywood";
import * as React from "react";
import { Essence, VisStrategy } from "../../../common/models/essence/essence";
import { SeriesDerivation } from "../../../common/models/series/concrete-series";
import { Series } from "../../../common/models/series/series";
import { SeriesSort, SortDirection } from "../../../common/models/sort/sort";
import { integerDivision } from "../../../common/utils/general/general";
import { TABLE_MANIFEST } from "../../../common/visualization-manifests/table/table";
import { HighlightModal } from "../../components/highlight-modal/highlight-modal";
import { Direction, ResizeHandle } from "../../components/resize-handle/resize-handle";
import { Scroller, ScrollerLayout } from "../../components/scroller/scroller";
import { BaseVisualization, BaseVisualizationState } from "../base-visualization/base-visualization";
import { Corner } from "./corner";
import { getFilterFromDatum } from "./filter-for-datum";
import { Highlighter } from "./highlight";
import { MeasureRows } from "./measure-rows";
import { MeasuresHeader } from "./measures-header";
import { segmentName } from "./segment-name";
import { Segments } from "./segments";
import "./table.scss";

const HIGHLIGHT_BUBBLE_V_OFFSET = -4;
const HEADER_HEIGHT = 38;
const SEGMENT_WIDTH = 300;
const THUMBNAIL_SEGMENT_WIDTH = 150;
export const INDENT_WIDTH = 25;
const MEASURE_WIDTH = 130;
export const ROW_HEIGHT = 30;
const SPACE_LEFT = 10;
const SPACE_RIGHT = 10;
const MIN_DIMENSION_WIDTH = 100;

function indexToColumnType(index: number): ColumnType {
  return [ColumnType.CURRENT, ColumnType.PREVIOUS, ColumnType.DELTA][index % 3];
}

function getSortPeriod(columnType: ColumnType): SeriesDerivation {
  switch (columnType) {
    case ColumnType.CURRENT:
      return SeriesDerivation.CURRENT;
    case ColumnType.PREVIOUS:
      return SeriesDerivation.PREVIOUS;
    case ColumnType.DELTA:
      return SeriesDerivation.DELTA;
  }
}

export enum ColumnType { CURRENT, PREVIOUS, DELTA }

export enum HoverElement { CORNER, ROW, HEADER, WHITESPACE, SPACE_LEFT }

export interface PositionHover {
  element: HoverElement;
  series?: Series;
  columnType?: ColumnType;
  row?: Datum;
}

export interface TableState extends BaseVisualizationState {
  flatData?: PseudoDatum[];
  hoverRow?: Datum;
  segmentWidth: number;
}

export class Table extends BaseVisualization<TableState> {
  protected className = TABLE_MANIFEST.name;
  protected innerTableRef = React.createRef<HTMLDivElement>();

  getDefaultState(): TableState {
    return { flatData: null, hoverRow: null, segmentWidth: this.defaultSegmentWidth(), ...super.getDefaultState() };
  }

  defaultSegmentWidth(): number {
    const { isThumbnail } = this.props;

    return isThumbnail ? THUMBNAIL_SEGMENT_WIDTH : SEGMENT_WIDTH;
  }

  maxSegmentWidth(): number {
    if (this.innerTableRef.current) {
      return this.innerTableRef.current.clientWidth - MIN_DIMENSION_WIDTH;
    }

    return this.defaultSegmentWidth();
  }

  getSegmentWidth(): number {
    const { segmentWidth } = this.state;
    return segmentWidth || this.defaultSegmentWidth();
  }

  calculateMousePosition(x: number, y: number): PositionHover {
    const { essence } = this.props;
    const { flatData } = this.state;

    if (x <= SPACE_LEFT) return { element: HoverElement.SPACE_LEFT };
    x -= SPACE_LEFT;

    if (y <= HEADER_HEIGHT) {
      if (x <= this.getSegmentWidth()) return { element: HoverElement.CORNER };
      const seriesList = essence.series.series;

      x = x - this.getSegmentWidth();
      const seriesWidth = this.getIdealColumnWidth();
      const seriesIndex = Math.floor(x / seriesWidth);
      if (essence.hasComparison()) {
        const nominalIndex = integerDivision(seriesIndex, 3);
        const series = seriesList.get(nominalIndex);
        if (!series) return { element: HoverElement.WHITESPACE };
        const columnType = indexToColumnType(seriesIndex);
        return { element: HoverElement.HEADER, series, columnType };
      }
      const series = seriesList.get(seriesIndex);
      if (!series) return { element: HoverElement.WHITESPACE };
      return { element: HoverElement.HEADER, series, columnType: ColumnType.CURRENT };
    }

    y = y - HEADER_HEIGHT;
    const rowIndex = Math.floor(y / ROW_HEIGHT);
    const datum = flatData ? flatData[rowIndex] : null;
    if (!datum) return { element: HoverElement.WHITESPACE };
    return { element: HoverElement.ROW, row: datum };
  }

  private setSort({ series, element, columnType }: PositionHover) {
    const { clicker, essence } = this.props;
    const { splits } = essence;
    switch (element) {
      case HoverElement.CORNER:
        clicker.changeSplits(splits.setSortToDimension(), VisStrategy.KeepAlways); // set each to dimension ascending
        return;
      case HoverElement.HEADER:
        const period = getSortPeriod(columnType);
        const commonSort = essence.getCommonSort();
        const reference = series.key();
        const sort = new SeriesSort({ reference, period, direction: SortDirection.descending });
        const sortWithDirection = commonSort && commonSort.equals(sort) ? sort.set("direction", SortDirection.ascending) : sort;
        clicker.changeSplits(splits.changeSort(sortWithDirection), VisStrategy.KeepAlways); // set all to measure
        return;
    }
    throw new Error(`Can't create sort reference for position element: ${element}`);
  }

  onClick = (x: number, y: number) => {
    const { clicker, essence } = this.props;
    const { splits } = essence;

    const mousePos = this.calculateMousePosition(x, y);
    const { row, element } = mousePos;

    switch (element) {
      case HoverElement.CORNER:
        this.setSort(mousePos);
        return;
      case HoverElement.HEADER:
        this.setSort(mousePos);
        return;
      case HoverElement.ROW:
        if (!clicker.dropHighlight || !clicker.changeHighlight) return;

        const rowHighlight = getFilterFromDatum(splits, row);

        if (!rowHighlight) return;

        if (essence.hasHighlight()) {
          if (rowHighlight.equals(essence.highlight.delta)) {
            clicker.dropHighlight();
            return;
          }
        }

        clicker.changeHighlight(null, rowHighlight);
        return;
      default:
        return;
    }
  }

  onMouseMove = (x: number, y: number) => {
    const { hoverRow } = this.state;
    const { row } = this.calculateMousePosition(x, y);
    if (hoverRow !== row) {
      this.setState({ hoverRow: row });
    }
  }

  onMouseLeave = () => {
    const { hoverRow } = this.state;
    if (hoverRow) {
      this.setState({ hoverRow: null });
    }
  }

  deriveDatasetState(dataset: Dataset): Partial<TableState> {
    if (!this.props.essence.splits.length()) return {};
    const flatDataset = dataset.flatten({ order: "preorder", nestingName: "__nest" });
    const flatData = flatDataset.data;
    return { flatData };
  }

  getScalesForColumns(essence: Essence, flatData: PseudoDatum[]): Array<d3.scale.Linear<number, number>> {
    const concreteSeries = essence.getConcreteSeries().toArray();
    const splitLength = essence.splits.length();

    return concreteSeries.map(series => {
      let measureValues = flatData
        .filter((d: Datum) => d["__nest"] === splitLength)
        .map((d: Datum) => series.selectValue(d));

      // Ensure that 0 is in there
      measureValues.push(0);

      return d3.scale.linear()
        .domain(d3.extent(measureValues))
        .range([0, 100]); // really those are percents
    });
  }

  getIdealColumnWidth(): number {
    const availableWidth = this.props.stage.width - SPACE_LEFT - this.getSegmentWidth();
    const columnsCount = this.columnsCount();

    return columnsCount * MEASURE_WIDTH >= availableWidth ? MEASURE_WIDTH : availableWidth / columnsCount;
  }

  onSimpleScroll = (scrollTop: number, scrollLeft: number) => this.setState({ scrollLeft, scrollTop });

  getVisibleIndices(rowCount: number, height: number): [number, number] {
    const { scrollTop } = this.state;

    return [
      Math.max(0, Math.floor(scrollTop / ROW_HEIGHT)),
      Math.min(rowCount, Math.ceil((scrollTop + height) / ROW_HEIGHT))
    ];
  }

  setSegmentWidth = (segmentWidth: number) => this.setState({ segmentWidth });

  private columnsCount(): number {
    const { essence } = this.props;
    const seriesCount = essence.getConcreteSeries().count();
    return essence.hasComparison() ? seriesCount * 3 : seriesCount;
  }

  private selectedRowIdx(): number | null {
    const { essence } = this.props;
    const { flatData } = this.state;
    if (!flatData) return null;
    if (!essence.hasHighlight()) return null;
    const { splits, highlight: { delta: filter } } = essence;
    const idx = flatData.findIndex(d => filter.equals(getFilterFromDatum(splits, d)));
    if (idx >= 0) return idx;
    return null;
  }

  protected renderInternals() {
    const { clicker, essence, stage } = this.props;
    const { flatData, scrollTop, hoverRow, segmentWidth } = this.state;
    const { splits, dataCube } = essence;

    const selectedIdx = this.selectedRowIdx();
    const columnWidth = this.getIdealColumnWidth();

    const columnsCount = this.columnsCount();
    const visibleRows = this.getVisibleIndices(flatData.length, stage.height);

    const scrollerLayout: ScrollerLayout = {
      // Inner dimensions
      bodyWidth: columnWidth * columnsCount + SPACE_RIGHT,
      bodyHeight: flatData ? flatData.length * ROW_HEIGHT : 0,

      // Gutters
      top: HEADER_HEIGHT,
      right: 0,
      bottom: 0,
      left: this.getSegmentWidth()
    };

    const segmentTitle = splits.splits.map(split => dataCube.getDimension(split.reference).title).join(", ");

    const overlay = selectedIdx !== null && flatData && <Highlighter
      top={selectedIdx * ROW_HEIGHT - scrollTop}
      left={Math.max(0, flatData[selectedIdx].__nest - 1) * INDENT_WIDTH} />;

    return <div className="internals table-inner" ref={this.innerTableRef}>
      <ResizeHandle
        direction={Direction.LEFT}
        onResize={this.setSegmentWidth}
        min={this.defaultSegmentWidth()}
        max={this.maxSegmentWidth()}
        value={segmentWidth}
      />
      <Scroller
        ref="scroller"
        layout={scrollerLayout}

        topGutter={
          <MeasuresHeader
            cellWidth={columnWidth}
            series={essence.getConcreteSeries().toArray()}
            commonSort={essence.getCommonSort()}
            showPrevious={essence.hasComparison()}
          />
        }

        leftGutter={flatData &&
          <Segments
            selectedIdx={selectedIdx}
            visibleRows={visibleRows}
            hoverRow={hoverRow}
            essence={essence}
            data={flatData}
            segmentWidth={this.getSegmentWidth()} />
        }

        topLeftCorner={<Corner title={segmentTitle} />}

        body={flatData &&
          <MeasureRows
            hoverRow={hoverRow}
            visibleRows={visibleRows}
            essence={essence}
            selectedIdx={selectedIdx}
            scales={this.getScalesForColumns(essence, flatData)}
            data={flatData}
            cellWidth={columnWidth}
            rowWidth={columnWidth * columnsCount} />}

        overlay={overlay}

        onClick={this.onClick}
        onMouseMove={this.onMouseMove}
        onMouseLeave={this.onMouseLeave}
        onScroll={this.onSimpleScroll}

      />

      {selectedIdx !== null &&
        <HighlightModal
          title={segmentName(flatData[selectedIdx], essence)}
          left={stage.x + stage.width / 2}
          top={stage.y + HEADER_HEIGHT + (selectedIdx * ROW_HEIGHT) - scrollTop - HIGHLIGHT_BUBBLE_V_OFFSET}
          clicker={clicker} />}
    </div>;
  }
}
