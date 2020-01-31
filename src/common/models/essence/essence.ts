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

import { Timezone } from "chronoshift";
import { List, OrderedSet, Record as ImmutableRecord, Set } from "immutable";
import { PlywoodRange, Range, RefExpression } from "plywood";
import { thread } from "../../utils/functional/functional";
import { visualizationIndependentEvaluator } from "../../utils/rules/visualization-independent-evaluator";
import { MANIFESTS } from "../../visualization-manifests";
import { Colors } from "../colors/colors";
import { DataCube } from "../data-cube/data-cube";
import { DateRange } from "../date-range/date-range";
import { Dimension } from "../dimension/dimension";
import { FilterClause, FixedTimeFilterClause, isTimeFilter, NumberFilterClause, TimeFilterClause, toExpression } from "../filter-clause/filter-clause";
import { Filter } from "../filter/filter";
import { Highlight } from "../highlight/highlight";
import { Measure } from "../measure/measure";
import { SeriesList } from "../series-list/series-list";
import { ConcreteSeries, SeriesDerivation } from "../series/concrete-series";
import createConcreteSeries from "../series/create-concrete-series";
import { Series } from "../series/series";
import { SeriesSortOn, SortOn } from "../sort-on/sort-on";
import { DimensionSort, isSortEmpty, SeriesSort, Sort, SortDirection, SortType } from "../sort/sort";
import { Split } from "../split/split";
import { Splits } from "../splits/splits";
import { TimeShift } from "../time-shift/time-shift";
import { TimeShiftEnv, TimeShiftEnvType } from "../time-shift/time-shift-env";
import { Timekeeper } from "../timekeeper/timekeeper";
import { Resolve, VisualizationManifest } from "../visualization-manifest/visualization-manifest";
import { VisualizationSettings } from "../visualization-settings/visualization-settings";

function constrainDimensions(dimensions: OrderedSet<string>, dataCube: DataCube): OrderedSet<string> {
  return <OrderedSet<string>> dimensions.filter(dimensionName => Boolean(dataCube.getDimension(dimensionName)));
}

export interface VisualizationAndResolve {
  visualization: VisualizationManifest;
  resolve: Resolve;
}

/**
 * FairGame   - Run all visualizations pretending that there is no current
 * UnfairGame - Run all visualizations but mark current vis as current
 * KeepAlways - Just keep the current one
 */
export enum VisStrategy {
  FairGame,
  UnfairGame,
  KeepAlways
}

type DimensionId = string;

export interface EssenceValue {
  dataCube: DataCube;
  visualization: VisualizationManifest;
  visualizationSettings: VisualizationSettings | null;
  timezone: Timezone;
  filter: Filter;
  timeShift: TimeShift;
  splits: Splits;
  series: SeriesList;
  pinnedDimensions: OrderedSet<DimensionId>;
  colors: Colors;
  pinnedSort: string;
  highlight: Highlight;
  visResolve?: Resolve;
}

const defaultEssence: EssenceValue = {
  dataCube: null,
  visualization: null,
  visualizationSettings: null,
  timezone: Timezone.UTC,
  filter: null,
  splits: null,
  series: null,
  pinnedDimensions: OrderedSet([]),
  pinnedSort: null,
  colors: null,
  highlight: null,
  timeShift: TimeShift.empty(),
  visResolve: null
};

export interface EffectiveFilterOptions {
  unfilterDimension?: Dimension;
  combineWithPrevious?: boolean;
}

type VisualizationResolverResult = Pick<EssenceValue, "splits" | "visualization" | "colors" | "visResolve">;
type VisualizationResolverParameters = Pick<EssenceValue, "visualization" | "dataCube" | "splits" | "colors" | "series">;

function resolveVisualization({ visualization, dataCube, splits, colors, series }: VisualizationResolverParameters): VisualizationResolverResult {

  let visResolve: Resolve;
  // Place vis here because it needs to know about splits and colors (and maybe later other things)
  if (!visualization) {
    const visAndResolve = Essence.getBestVisualization(dataCube, splits, series, colors, null);
    visualization = visAndResolve.visualization;
  }

  const ruleVariables = { dataCube, series, splits, colors, isSelectedVisualization: true };
  visResolve = visualization.evaluateRules(ruleVariables);
  if (visResolve.isAutomatic()) {
    const adjustment = visResolve.adjustment;
    splits = adjustment.splits;
    colors = adjustment.colors || null;
    visResolve = visualization.evaluateRules({ ...ruleVariables, splits, colors });

    if (!visResolve.isReady()) {
      throw new Error(visualization.title + " must be ready after automatic adjustment");
    }
  }

  if (visResolve.isReady()) {
    visResolve = visualizationIndependentEvaluator({ dataCube, series });
  }
  return { visualization, splits, colors, visResolve };
}

export class Essence extends ImmutableRecord<EssenceValue>(defaultEssence) {

  static getBestVisualization(
    dataCube: DataCube,
    splits: Splits,
    series: SeriesList,
    colors: Colors,
    currentVisualization: VisualizationManifest
  ): VisualizationAndResolve {
    const visAndResolves = MANIFESTS.map(visualization => {
      const isSelectedVisualization = visualization === currentVisualization;
      const ruleVariables = { dataCube, splits, series, colors, isSelectedVisualization };
      return {
        visualization,
        resolve: visualization.evaluateRules(ruleVariables)
      };
    });

    return visAndResolves.sort((vr1, vr2) => Resolve.compare(vr1.resolve, vr2.resolve))[0];
  }

  static fromDataCube(dataCube: DataCube): Essence {
    const essence = new Essence({
      dataCube,
      visualization: null,
      visualizationSettings: null,
      timezone: dataCube.getDefaultTimezone(),
      filter: dataCube.getDefaultFilter(),
      timeShift: TimeShift.empty(),
      splits: dataCube.getDefaultSplits(),
      series: SeriesList.fromMeasureNames(dataCube.getDefaultSelectedMeasures().toArray()),
      pinnedDimensions: dataCube.getDefaultPinnedDimensions(),
      colors: null,
      pinnedSort: dataCube.getDefaultSortMeasure(),
      highlight: null
    });

    return essence.updateSplitsWithFilter();
  }

  static defaultSortReference(series: SeriesList, dataCube: DataCube): string {
    const seriesRefs = Set(series.series.map(series => series.key()));
    const defaultSort = dataCube.getDefaultSortMeasure();
    if (seriesRefs.has(defaultSort)) return defaultSort;
    return seriesRefs.first();
  }

  static defaultSort(series: SeriesList, dataCube: DataCube): Sort {
    const reference = Essence.defaultSortReference(series, dataCube);
    return new SeriesSort({ reference });
  }

  static timeFilter(filter: Filter, dataCube: DataCube): TimeFilterClause {
    const timeFilter = filter.getClauseForDimension(dataCube.getTimeDimension());
    if (!isTimeFilter(timeFilter)) throw new Error(`Unknown time filter: ${timeFilter}`);
    return timeFilter;
  }

  public visResolve: Resolve;

  constructor(parameters: EssenceValue) {
    const {
      filter,
      dataCube,
      timezone,
      timeShift,
      series,
      pinnedDimensions,
      pinnedSort,
      highlight
    } = parameters;

    if (!dataCube) throw new Error("Essence must have a dataCube");

    const { visResolve, visualization, colors, splits } = resolveVisualization(parameters);

    const newHighlight = highlight && highlight.validForSeries(series) ? highlight : null;

    const constrainedSeries = series && series.constrainToMeasures(dataCube.measures);

    const isPinnedSortValid = series && constrainedSeries.hasMeasureSeries(pinnedSort);
    const constrainedPinnedSort = isPinnedSortValid ? pinnedSort : Essence.defaultSortReference(constrainedSeries, dataCube);

    const constrainedFilter = filter.constrainToDimensions(dataCube.dimensions);

    const validTimezone = timezone || Timezone.UTC;

    const timeFilter = Essence.timeFilter(filter, dataCube);
    const constrainedTimeShift = timeShift.constrainToFilter(timeFilter, validTimezone);

    super({
      ...parameters,
      dataCube,
      visualization,
      timezone: validTimezone,
      timeShift: constrainedTimeShift,
      splits: splits && splits.constrainToDimensionsAndSeries(dataCube.dimensions, constrainedSeries),
      filter: constrainedFilter,
      series: constrainedSeries,
      pinnedDimensions: constrainDimensions(pinnedDimensions, dataCube),
      pinnedSort: constrainedPinnedSort,
      colors,
      highlight: newHighlight && newHighlight.constrainToDimensions(dataCube.dimensions),
      visResolve
    });
  }

  public toString(): string {
    return "[Essence]";
  }

  public toJS() {
    return {
      visualization: this.visualization,
      visualizationSettings: this.visualizationSettings,
      dataCube: this.dataCube.toJS(),
      timezone: this.timezone.toJS(),
      filter: this.filter && this.filter.toJS(),
      splits: this.splits && this.splits.toJS(),
      series: this.series.toJS(),
      timeShift: this.timeShift.toJS(),
      colors: this.colors && this.colors.toJS(),
      pinnedSort: this.pinnedSort,
      pinnedDimensions: this.pinnedDimensions.toJS(),
      highlight: this.highlight && this.highlight.toJS(),
      visResolve: this.visResolve
    };
  }

  // getters
  public getTimeAttribute(): RefExpression {
    return this.dataCube.timeAttribute;
  }

  public getTimeDimension(): Dimension {
    return this.dataCube.getTimeDimension();
  }

  public evaluateSelection(filter: TimeFilterClause, timekeeper: Timekeeper): FixedTimeFilterClause {
    if (filter instanceof FixedTimeFilterClause) return filter;
    const { timezone, dataCube } = this;
    return filter.evaluate(timekeeper.now(), dataCube.getMaxTime(timekeeper), timezone);
  }

  private combineWithPrevious(filter: Filter) {
    const timeDimension: Dimension = this.getTimeDimension();
    const timeFilter: FilterClause = filter.getClauseForDimension(timeDimension);
    if (!timeFilter || !(timeFilter instanceof FixedTimeFilterClause)) {
      throw new Error("Can't combine current time filter with previous period without time filter");
    }
    return filter.setClause(this.combinePeriods(timeFilter));
  }

  public getTimeShiftEnv(timekeeper: Timekeeper): TimeShiftEnv {
    const timeDimension = this.getTimeDimension();
    if (!this.hasComparison()) {
      return { type: TimeShiftEnvType.CURRENT };
    }

    const currentFilter = toExpression(this.currentTimeFilter(timekeeper), timeDimension);
    const previousFilter = toExpression(this.previousTimeFilter(timekeeper), timeDimension);
    return {
      type: TimeShiftEnvType.WITH_PREVIOUS,
      shift: this.timeShift.valueOf(),
      currentFilter,
      previousFilter
    };
  }

  private constrainTimeShift(): Essence {
    const { timeShift, timezone } = this;
    return this.set("timeShift", timeShift.constrainToFilter(this.timeFilter(), timezone));
  }

  public getEffectiveFilter(
    timekeeper: Timekeeper,
    { combineWithPrevious = false, unfilterDimension = null }: EffectiveFilterOptions = {}): Filter {
    const { dataCube, timezone } = this;
    let filter = this.filter;
    if (unfilterDimension) filter = filter.removeClause(unfilterDimension.name);
    filter = filter.getSpecificFilter(timekeeper.now(), dataCube.getMaxTime(timekeeper), timezone);
    if (combineWithPrevious) {
      filter = this.combineWithPrevious(filter);
    }
    return filter;
  }

  public hasComparison(): boolean {
    return !this.timeShift.isEmpty();
  }

  private combinePeriods(timeFilter: FixedTimeFilterClause): TimeFilterClause {
    const { timezone, timeShift } = this;
    const duration = timeShift.valueOf();
    return timeFilter.update("values", values =>
      values.flatMap(({ start, end }) =>
        [
          new DateRange({ start, end }),
          new DateRange({ start: duration.shift(start, timezone, -1), end: duration.shift(end, timezone, -1) })
        ]));
  }

  public timeFilter(): TimeFilterClause {
    const { filter, dataCube } = this;
    return Essence.timeFilter(filter, dataCube);
  }

  private fixedTimeFilter(timekeeper: Timekeeper): FixedTimeFilterClause {
    const { dataCube, timezone } = this;
    const timeFilter = this.timeFilter();
    if (timeFilter instanceof FixedTimeFilterClause) return timeFilter;
    return timeFilter.evaluate(timekeeper.now(), dataCube.getMaxTime(timekeeper), timezone);
  }

  public currentTimeFilter(timekeeper: Timekeeper): FixedTimeFilterClause {
    return this.fixedTimeFilter(timekeeper);
  }

  private shiftToPrevious(timeFilter: FixedTimeFilterClause): FixedTimeFilterClause {
    const { timezone, timeShift } = this;
    const duration = timeShift.valueOf();
    return timeFilter.update("values", values =>
      values.map(({ start, end }) => new DateRange({
        start: duration.shift(start, timezone, -1),
        end: duration.shift(end, timezone, -1)
      })));
  }

  public previousTimeFilter(timekeeper: Timekeeper): FixedTimeFilterClause {
    const timeFilter = this.fixedTimeFilter(timekeeper);
    return this.shiftToPrevious(timeFilter);
  }

  public getTimeClause(): TimeFilterClause {
    const timeDimension = this.getTimeDimension();
    return this.filter.getClauseForDimension(timeDimension) as TimeFilterClause;
  }

  private concreteSeriesFromSeries(series: Series): ConcreteSeries {
    const { reference } = series;
    const { dataCube } = this;
    const measure = dataCube.getMeasure(reference);
    return createConcreteSeries(series, measure, dataCube.measures);
  }

  public findConcreteSeries(key: string): ConcreteSeries {
    const series = this.series.series.find(series => series.key() === key);
    if (!series) return null;
    return this.concreteSeriesFromSeries(series);
  }

  public getConcreteSeries(): List<ConcreteSeries> {
    return this.series.series.map(series => this.concreteSeriesFromSeries(series));
  }

  public differentDataCube(other: Essence): boolean {
    return this.dataCube !== other.dataCube;
  }

  public differentSplits(other: Essence): boolean {
    return !this.splits.equals(other.splits);
  }

  public differentTimeShift(other: Essence): boolean {
    return !this.timeShift.equals(other.timeShift);
  }

  public differentColors(other: Essence): boolean {
    if (Boolean(this.colors) !== Boolean(other.colors)) return true;
    if (!this.colors) return false;
    return !this.colors.equals(other.colors);
  }

  public differentSeries(other: Essence): boolean {
    return !this.series.equals(other.series);
  }

  public differentEffectiveFilter(other: Essence, myTimekeeper: Timekeeper, otherTimekeeper: Timekeeper, unfilterDimension: Dimension = null): boolean {
    const myEffectiveFilter = this.getEffectiveFilter(myTimekeeper, { unfilterDimension });
    const otherEffectiveFilter = other.getEffectiveFilter(otherTimekeeper, { unfilterDimension });
    return !myEffectiveFilter.equals(otherEffectiveFilter);
  }

  public hasHighlight(): boolean {
    return !!this.highlight;
  }

  public highlightOn(measure: string): boolean {
    const { highlight } = this;
    if (!highlight) return false;
    return highlight.measure === measure;
  }

  public getHighlightRange(): PlywoodRange {
    const { highlight } = this;
    if (!highlight) return null;
    const clause = highlight.delta.clauses.first();
    if ((clause instanceof NumberFilterClause) || (clause instanceof FixedTimeFilterClause)) {
      return Range.fromJS(clause.values.first());
    }
    return null;
  }

  public getCommonSort(): Sort {
    return this.splits.getCommonSort();
  }

  // Setters

  public changeComparisonShift(timeShift: TimeShift): Essence {
    return this
      .set("timeShift", timeShift)
      .constrainTimeShift()
      .updateSorts();
  }

  public updateDataCube(newDataCube: DataCube): Essence {
    const { dataCube } = this;
    if (dataCube.equals(newDataCube)) return this;
    const newSeriesList = this.series.constrainToMeasures(newDataCube.measures);
    return this
      .set("dataCube", newDataCube)
      // Make sure that all the elements of state are still valid
      /*
        TODO: Tthis line was here and there was some check for old timeFilter, really don't know what was that for.
      .update("filter", filter => filter.constrainToDimensions(newDataCube.dimensions, newDataCube.timeAttribute, dataCube.timeAttribute))
      */
      .update("filter", filter => filter.constrainToDimensions(newDataCube.dimensions))
      .set("series", newSeriesList)
      .update("splits", splits => splits.constrainToDimensionsAndSeries(newDataCube.dimensions, newSeriesList))
      .update("pinnedDimensions", pinned => constrainDimensions(pinned, newDataCube))
      .update("colors", colors => colors && !newDataCube.getDimension(colors.dimension) ? null : colors)
      .update("pinnedSort", sort => !newDataCube.getMeasure(sort) ? newDataCube.getDefaultSortMeasure() : sort)
      .update("highlight", highlight => highlight && highlight.constrainToDimensions(newDataCube.dimensions))
      .resolveVisualizationAndUpdate();
  }

  public changeFilter(filter: Filter, removeHighlight = false): Essence {
    const { filter: oldFilter } = this;

    return this
      .set("filter", filter)
      .constrainTimeShift()
      .update("highlight", highlight => removeHighlight ? null : highlight)
      .update("splits", splits => {
        const differentClauses = filter.clauses.filter(clause => {
          const otherClause = oldFilter.clauseForReference(clause.reference);
          return !clause.equals(otherClause);
        });
        return splits.removeBucketingFrom(Set(differentClauses.map(clause => clause.reference)));
      })
      .updateSplitsWithFilter();
  }

  public changeTimezone(newTimezone: Timezone): Essence {
    const { timezone } = this;
    if (timezone === newTimezone) return this;
    return this.set("timezone", newTimezone);
  }

  public convertToSpecificFilter(timekeeper: Timekeeper): Essence {
    const { dataCube, filter, timezone } = this;
    if (!filter.isRelative()) return this;
    return this.changeFilter(filter.getSpecificFilter(timekeeper.now(), dataCube.getMaxTime(timekeeper), timezone));
  }

  private defaultSplitSort(split: Split): Sort {
    const { dataCube, series } = this;
    const dimension = dataCube.getDimension(split.reference);
    const { sortStrategy, name, kind } = dimension;
    if (sortStrategy === "self" || sortStrategy === name) {
      return new DimensionSort({ reference: name, direction: SortDirection.ascending });
    }
    if (sortStrategy && series.hasMeasureSeries(sortStrategy)) {
      return new SeriesSort({ reference: sortStrategy, direction: SortDirection.descending });
    }
    if (kind === "time") {
      return new DimensionSort({ reference: name, direction: SortDirection.ascending });
    }
    return new SeriesSort({ reference: this.defaultSort(), direction: SortDirection.descending });
  }

  private setSortOnSplits(splits: Splits): Splits {
    return splits.update("splits", list => list.map(split => {
      return isSortEmpty(split.sort) ? split.set("sort", this.defaultSplitSort(split)) : split;
    }));
  }

  public changeSplits(splits: Splits, strategy: VisStrategy): Essence {
    const { splits: oldSplits, highlight, dataCube, visualization, visResolve, filter, series, colors } = this;

    function adjustHighlight(essence: Essence): Essence {
      if (!essence.highlight) return essence;
      return essence
        .update("filter", filter => highlight.applyToFilter(filter))
        .constrainTimeShift()
        .set("highlight", null);
    }

    const newSplits = this.setSortOnSplits(splits).updateWithFilter(filter, dataCube.dimensions);

    function adjustStrategy(strategy: VisStrategy): VisStrategy {
      // If in manual mode stay there, keep the vis regardless of suggested strategy
      if (visResolve.isManual()) {
        return VisStrategy.KeepAlways;
      }
      if (oldSplits.length() > 0 && newSplits.length() !== 0) {
        return VisStrategy.UnfairGame;
      }
      return strategy;
    }

    function adjustVisualization(essence: Essence): Essence {
      if (adjustStrategy(strategy) !== VisStrategy.FairGame) return essence;
      const { visualization: newVis } = Essence.getBestVisualization(dataCube, newSplits, series, colors, visualization);
      if (newVis === visualization) return essence;
      return essence.changeVisualization(newVis, newVis.visualizationSettings.defaults);
    }

    return thread(
      this,
      adjustHighlight,
      (essence: Essence) => essence.set("splits", newSplits),
      adjustVisualization,
      (essence: Essence) => essence.resolveVisualizationAndUpdate());
  }

  public changeSplit(splitCombine: Split, strategy: VisStrategy): Essence {
    return this.changeSplits(Splits.fromSplit(splitCombine), strategy);
  }

  public addSplit(split: Split, strategy: VisStrategy): Essence {
    return this.changeSplits(this.splits.addSplit(split), strategy);
  }

  public removeSplit(split: Split, strategy: VisStrategy): Essence {
    return this.changeSplits(this.splits.removeSplit(split), strategy);
  }

  addSeries(series: Series): Essence {
    return this.changeSeriesList(this.series.addSeries(series));
  }

  removeSeries(series: Series): Essence {
    return this.changeSeriesList(this.series.removeSeries(series));
  }

  changeSeriesList(series: SeriesList): Essence {
    return this
      .set("series", series)
      .updateSorts()
      .resolveVisualizationAndUpdate();
  }

  public defaultSort(): string {
    return Essence.defaultSortReference(this.series, this.dataCube);
  }

  private updateSorts(): Essence {
    const seriesRefs = Set(this.series.series.map(series => series.reference));
    return this
      .update("pinnedSort", sort => {
        if (seriesRefs.has(sort)) return sort;
        return this.defaultSort();
      })
      .update("splits", splits => splits.update("splits", splits => splits.map((split: Split) => {
        const { sort } = split;
        const { type, reference } = sort;
        switch (type) {
          case SortType.DIMENSION:
            return split;
          case SortType.SERIES: {
            const measureSort = sort as SeriesSort;
            if (!seriesRefs.has(reference)) {
              const measureSortRef = this.defaultSort();
              if (measureSortRef) {
                return split.changeSort(new SeriesSort({
                  reference: measureSortRef
                }));
              }
              return split.changeSort(new DimensionSort({
                reference: split.reference
              }));
            }
            if (measureSort.period !== SeriesDerivation.CURRENT && !this.hasComparison()) {
              return split.update("sort", (sort: SeriesSort) =>
                sort.set("period", SeriesDerivation.CURRENT));
            }
            return split;
          }
        }
      })));
  }

  public updateSplitsWithFilter(): Essence {
    const { filter, dataCube: { dimensions }, splits } = this;
    const newSplits = splits.updateWithFilter(filter, dimensions);
    if (splits === newSplits) return this;
    return this.set("splits", newSplits).resolveVisualizationAndUpdate();
  }

  public changeColors(colors: Colors): Essence {
    return this.set("colors", colors).resolveVisualizationAndUpdate();
  }

  public changeVisualization(visualization: VisualizationManifest, settings: VisualizationSettings = visualization.visualizationSettings.defaults): Essence {
    return this
      .set("visualization", visualization)
      .set("visualizationSettings", settings)
      .resolveVisualizationAndUpdate();
  }

  public resolveVisualizationAndUpdate() {
    const { visualization, colors, splits, dataCube, series } = this;
    const result = resolveVisualization({ colors, splits, dataCube, visualization, series });
    return this
      .set("visResolve", result.visResolve)
      .set("colors", result.colors)
      .set("visualization", result.visualization)
      .set("splits", result.splits);
  }

  public pin({ name }: Dimension): Essence {
    return this.update("pinnedDimensions", pinned => pinned.add(name));
  }

  public unpin({ name }: Dimension): Essence {
    return this.update("pinnedDimensions", pinned => pinned.remove(name));
  }

  public getPinnedSortMeasure(): Measure {
    return this.dataCube.getMeasure(this.pinnedSort);
  }

  public changePinnedSortMeasure({ name }: Measure): Essence {
    return this.set("pinnedSort", name);
  }

  public acceptHighlight(): Essence {
    const { highlight } = this;
    if (!highlight) return this;
    return this.changeFilter(highlight.applyToFilter(this.filter), true);
  }

  public changeHighlight(newHighlight: Highlight): Essence {
    if (!newHighlight.validForSeries(this.series)) return this;
    return this.set("highlight", newHighlight);
  }

  public dropHighlight(): Essence {
    return this.set("highlight", null);
  }

  public seriesSortOns(withTimeShift?: boolean): List<SortOn> {
    const series = this.getConcreteSeries();
    const addPrevious = withTimeShift && this.hasComparison();
    if (!addPrevious) return series.map(series => new SeriesSortOn(series));
    return series.flatMap(series => {
      return [
        new SeriesSortOn(series),
        new SeriesSortOn(series, SeriesDerivation.PREVIOUS),
        new SeriesSortOn(series, SeriesDerivation.DELTA)
      ];
    });
  }
}
