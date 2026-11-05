const availableIntervals = [
	'1', '3', '5', '15', '30', '60', '240', '1D'
];

const availableIndicators = [
	{
		name: 'Volume',
		inputs: []
	},
	{
		name: 'Relative Strength Index',
		inputs: [14]
	}
];

const disabledFeatures = [
	"trading_account_manager",
	"right_toolbar",
	"items_favoriting",
	"save_chart_properties_to_local_storage",
	"create_volume_indicator_by_default",
	"create_volume_indicator_by_default_once",
	"volume_force_overlay",
	"right_bar_stays_on_scroll",
	"constraint_dialogs_movement",
	"charting_library_debug_mode",
	"side_toolbar_in_fullscreen_mode",
	"header_in_fullscreen_mode",
	"disable_resolution_rebuild",
	// "chart_scroll",
	// "chart_zoom",
	// "horz_touch_drag_scroll",
	// "vert_touch_drag_scroll",
	// "mouse_wheel_scroll",
	// "pressed_mouse_move_scroll",
	// "mouse_wheel_scale",
	// "pinch_scale",
	// "axis_pressed_mouse_move_scale",
	"low_density_bars",
	"uppercase_instrument_names",
	"no_min_chart_width",
	"fix_left_edge",
	"lock_visible_time_range_on_resize",
	"shift_visible_range_on_new_bar",
	"custom_resolutions",
	"end_of_period_timescale_marks",
	"cropped_tick_marks",
	// "study_overlay_compare_legend_option",
	// "study_symbol_ticker_description",
	// "auto_enable_symbol_labels",
	"insert_indicator_dialog_shortcut",
	"two_character_bar_marks_labels",
	"confirm_overwrite_if_chart_layout_with_name_exists",
	"determine_first_data_request_size_using_visible_range",
	"move_logo_to_main_pane",
	"study_templates",
	"datasource_copypaste",
	"seconds_resolution",
	"tick_resolution",
	"secondary_series_extend_time_scale",
	"header_widget",
	"header_symbol_search",
	"symbol_search_hot_key",
	"allow_arbitrary_symbol_search_input",
	"header_resolutions",
	"show_interval_dialog_on_key_press",
	"header_chart_type",
	"header_settings",
	// "header_indicators",
	"header_compare",
	"header_undo_redo",
	"header_quick_search",
	"header_screenshot",
	"header_fullscreen_button",
	// "border_around_the_chart",
	"header_saveload",
	"left_toolbar",
	"control_bar",
	"timeframes_toolbar",
	// "legend_widget",
	"display_legend_on_all_charts",
	"object_tree_legend_mode",
	"edit_buttons_in_legend",
	"show_hide_button_in_legend",
	"format_button_in_legend",
	"delete_button_in_legend",
	"context_menus",
	"pane_context_menu",
	"scales_context_menu",
	"legend_context_menu",
	// "main_series_scale_menu",
	// "display_market_status",
	"remove_library_container_border",
	"property_pages",
	"show_chart_property_page",
	"chart_property_page_scales",
	"chart_property_page_trading",
	"chart_property_page_right_margin_editor",
	// "countdown",
	"dont_show_boolean_study_arguments",
	"hide_last_na_study_output",
	"symbol_info",
	"timezone_menu",
	"snapshot_trading_drawings",
	"source_selection_markers",
	"go_to_date",
	"adaptive_logo",
	"show_dom_first_time",
	"hide_left_toolbar_by_default",
	"chart_style_hilo",
	"chart_style_hilo_last_price",
	"pricescale_currency",
	"pricescale_unit",
	"scales_date_format",
	"popup_hints",
	"save_shortcut",
	"show_right_widgets_panel_by_default",
	"show_object_tree",
	"show_spread_operators",
	"hide_exponentiation_spread_operator",
	"hide_reciprocal_spread_operator",
	"compare_symbol_search_spread_operators",
	"studies_symbol_search_spread_operators",
	"hide_resolution_in_legend",
	"hide_unresolved_symbols_in_legend",
	"show_zoom_and_move_buttons_on_touch",
	"hide_main_series_symbol_from_indicator_legend",
	"hide_price_scale_global_last_bar_value",
	// "show_average_close_price_line_and_label",
	// "hide_image_invalid_symbol",
	"hide_object_tree_and_price_scale_exchange_label",
	"scales_time_hours_format",
	"use_na_string_for_not_available_values",
	// "pre_post_market_sessions",
	"show_percent_option_for_right_margin",
	"lock_visible_time_range_when_adjusting_percentage_right_margin",
	"iframe_loading_compatibility_mode",
	"use_last_visible_bar_value_in_legend",
	"symbol_info_long_description",
	"symbol_info_price_source",
	"chart_template_storage",
	"request_only_visible_range_on_reset",
	"clear_price_scale_on_error_or_empty_bars",
	"legend_inplace_edit",
	"disable_legend_inplace_resolution_change",
	"disable_legend_inplace_symbol_change",
	"show_symbol_logos",
	"show_exchange_logos",
	// "show_symbol_logo_in_legend",
	"show_symbol_logo_for_compare_studies",
	"always_show_legend_values_on_mobile",
	"studies_extend_time_scale",
	"accessible_keyboard_shortcuts",
	"aria_detailed_chart_descriptions",
	"aria_crosshair_price_description",
	"saveload_separate_drawings_storage",
	"disable_pulse_animation",
	"iframe_loading_same_origin",
	"library_custom_color_themes",
	"use_symbol_name_for_header_toolbar",
	// "inactivity_gaps",
	// "long_press_floating_tooltip",
	// "legend_bar_change_colors_based_on_value",
	"chart_drag_export",
	// "always_show_study_symbol_input_values_in_legend"
];

const minimalDisabledFeatures = [
	// "header_widget",
	// "legend_inplace_edit",
	// "trading_account_manager",
	// "symbol_search_hot_key",
	// "header_symbol_search",
	// "header_compare",
	// "left_toolbar",
	// "right_toolbar",
]

const syncDrawing = (widget) => {
	// --- Cross-Tab Drawing Sync Setup ---

	// Unique tab ID (stable for this tab's lifetime)
	window.TV_TAB_ID = window.TV_TAB_ID || (Date.now() + '_' + Math.random().toString(36).substr(2, 9));

	// Shared BroadcastChannel — all same-origin tabs share this
	if (!window.drawingChannel) {
		window.drawingChannel = new BroadcastChannel('tradingview_drawings_sync');
	}

	// Guard flag: prevents re-broadcasting drawings we received from another tab
	window.isApplyingRemoteDrawings = false;

	// Last broadcasted snapshot (for change detection in polling)
	window._lastDrawingSnapshot = window._lastDrawingSnapshot || '';

	// Snapshot all shapes from all charts into a serializable array
	function snapshotAllShapes() {
		const allChartsShapes = [];
		for (let i = 0; i < widget.chartsCount(); i++) {
			const chart = widget.chart(i);
			const shapes = chart.getAllShapes();
			const shapesData = [];

			for (const shape of shapes) {
				try {
					const api = chart.getShapeById(shape.id);
					if (api) {
						shapesData.push({
							name: shape.name,
							points: api.getPoints(),
							overrides: api.getProperties()
						});
					}
				} catch (e) { /* shape may have been deleted mid-loop */ }
			}
			allChartsShapes.push(shapesData);
		}
		return allChartsShapes;
	}

	// Broadcast current shapes to all other tabs
	function broadcastDrawings() {
		if (window.isApplyingRemoteDrawings) return;

		const allChartsShapes = snapshotAllShapes();
		const snapshot = JSON.stringify(allChartsShapes);

		// Only broadcast if something actually changed
		if (snapshot === window._lastDrawingSnapshot) return;
		window._lastDrawingSnapshot = snapshot;

		window.drawingChannel.postMessage({
			type: 'drawings_update',
			sender: window.TV_TAB_ID,
			charts: allChartsShapes
		});
	}

	// Detect drawing events (create, move, remove) — immediate sync
	widget.subscribe('drawing_event', (id, eventType) => {
		if (window.isApplyingRemoteDrawings) return;
		if (eventType === 'click') return; // skip click events

		clearTimeout(window._drawSyncDebounce);
		window._drawSyncDebounce = setTimeout(() => {
			broadcastDrawings();
		}, 300);
	});

	// Polling: catches property changes (color, width, resize, etc.) that drawing_event does NOT fire for
	if (window._drawSyncInterval) clearInterval(window._drawSyncInterval);
	window._drawSyncInterval = setInterval(() => {
		if (window.isApplyingRemoteDrawings) return;
		broadcastDrawings();
	}, 2000);

	// Receive drawings from other tabs and apply them
	window.drawingChannel.onmessage = (e) => {
		const data = e.data;
		if (!data || data.type !== 'drawings_update') return;
		if (data.sender === window.TV_TAB_ID) return;

		window.isApplyingRemoteDrawings = true;

		for (let i = 0; i < Math.min(widget.chartsCount(), data.charts.length); i++) {
			try {
				const chart = widget.chart(i);
				const remoteShapes = data.charts[i];
				if (!remoteShapes) continue;

				// Clear existing shapes to prevent duplicates
				chart.getAllShapes().forEach(shape => {
					try { chart.removeEntity(shape.id); } catch (e) { }
				});

				// Recreate each shape from the remote data
				for (const s of remoteShapes) {
					try {
						if (s.points.length > 1) {
							chart.createMultipointShape(s.points, {
								shape: s.name,
								overrides: s.overrides
							});
						} else if (s.points.length === 1) {
							chart.createShape(s.points[0], {
								shape: s.name,
								overrides: s.overrides
							});
						}
					} catch (shapeErr) {
						console.warn('[Drawing Sync] Could not recreate shape:', s.name, shapeErr);
					}
				}
			} catch (err) {
				console.warn('[Drawing Sync] Error applying to chart', i, err);
			}
		}

		// Update local snapshot so polling doesn't re-broadcast what we just received
		window._lastDrawingSnapshot = JSON.stringify(data.charts);

		setTimeout(() => { window.isApplyingRemoteDrawings = false; }, 1500);
	};
}

export {
	availableIntervals,
	availableIndicators,
	disabledFeatures,
	minimalDisabledFeatures,
	syncDrawing
}