package tv.mbolo.app.ui

import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.TextView
import androidx.recyclerview.widget.DiffUtil
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.ListAdapter
import androidx.recyclerview.widget.RecyclerView
import coil3.request.Disposable
import tv.mbolo.app.R
import tv.mbolo.app.core.TileUi

/**
 * Tuiles virtualisées : aucun appel réseau dans onBind (Coil async + borné),
 * requêtes d'images annulées au recyclage, priorité aux éléments visibles.
 * `fixedWidthDp` > 0 : largeur fixe (rangées horizontales) ; 0 = match_parent
 * (grilles : la colonne GridLayoutManager impose la largeur, un 160dp fixe
 * dépasserait sur téléphone 360dp → clipping).
 */
class TileAdapter(
    private val imgW: Int,
    private val imgH: Int,
    private val onClick: (TileUi) -> Unit,
    private val fixedWidthDp: Int = 0,
) : ListAdapter<TileUi, TileAdapter.VH>(DIFF) {

    inner class VH(v: View) : RecyclerView.ViewHolder(v) {
        val img: ImageView = v.findViewById(R.id.tile_image)
        val title: TextView = v.findViewById(R.id.tile_title)
        val sub: TextView = v.findViewById(R.id.tile_sub)
        var disposable: Disposable? = null
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): VH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_tile, parent, false)
        if (fixedWidthDp > 0) {
            val px = (fixedWidthDp * parent.context.resources.displayMetrics.density).toInt()
            v.layoutParams = RecyclerView.LayoutParams(px, RecyclerView.LayoutParams.WRAP_CONTENT)
        }
        // Focus TV explicite : le sélecteur de fond marque l'élément (pas d'anim).
        v.isFocusable = true
        v.isFocusableInTouchMode = true
        return VH(v)
    }

    override fun onBindViewHolder(h: VH, position: Int) {
        val t = getItem(position)
        h.title.text = t.title
        if (t.subtitle.isNullOrBlank()) h.sub.visibility = View.GONE
        else {
            h.sub.visibility = View.VISIBLE
            h.sub.text = t.subtitle
        }
        h.disposable?.dispose()
        h.disposable = NativeImages.load(h.img, t.imageUrl, imgW, imgH)
        h.itemView.setOnClickListener { onClick(t) }
    }

    override fun onViewRecycled(h: VH) {
        // Annule la requête image hors écran (Wi-Fi lent ne bloque pas l'UI).
        h.disposable?.dispose()
        h.disposable = null
        h.img.setImageDrawable(null)
        h.itemView.setOnClickListener(null)
        super.onViewRecycled(h)
    }

    private companion object {
        val DIFF = object : DiffUtil.ItemCallback<TileUi>() {
            override fun areItemsTheSame(a: TileUi, b: TileUi) = a.kind == b.kind && a.id == b.id
            override fun areContentsTheSame(a: TileUi, b: TileUi) = a == b
        }
    }
}

data class HomeRowUi(val title: String, val tiles: List<TileUi>)

/**
 * Accueil : RecyclerView verticale de rangées, chaque rangée = RecyclerView
 * horizontale virtualisée. Pool partagé + prefetch limité (0 en low-RAM).
 */
class HomeRowAdapter(
    private val imgW: Int,
    private val imgH: Int,
    private val pool: RecyclerView.RecycledViewPool,
    private val prefetch: Int,
    private val onClick: (TileUi) -> Unit,
) : ListAdapter<HomeRowUi, HomeRowAdapter.RowVH>(DIFF) {

    inner class RowVH(v: View) : RecyclerView.ViewHolder(v) {
        val title: TextView = v.findViewById(R.id.row_title)
        val list: RecyclerView = v.findViewById(R.id.row_list)
        // Créés UNE fois (onCreate) : recréer LM + adapter à chaque bind
        // réinitialisait le scroll interne et rechargeait les images (jank).
        val inner: TileAdapter = TileAdapter(imgW, imgH, onClick, fixedWidthDp = 160)

        init {
            val lm = LinearLayoutManager(v.context, LinearLayoutManager.HORIZONTAL, false)
            lm.initialPrefetchItemCount = prefetch
            list.layoutManager = lm
            list.setRecycledViewPool(pool)
            list.setHasFixedSize(true)
            list.setItemViewCacheSize(2)
            list.adapter = inner
        }
    }

    override fun onCreateViewHolder(parent: ViewGroup, viewType: Int): RowVH {
        val v = LayoutInflater.from(parent.context).inflate(R.layout.item_home_row, parent, false)
        return RowVH(v)
    }

    override fun onBindViewHolder(h: RowVH, position: Int) {
        val row = getItem(position)
        h.title.text = row.title
        h.inner.submitList(row.tiles)
    }

    private companion object {
        val DIFF = object : DiffUtil.ItemCallback<HomeRowUi>() {
            override fun areItemsTheSame(a: HomeRowUi, b: HomeRowUi) = a.title == b.title
            override fun areContentsTheSame(a: HomeRowUi, b: HomeRowUi) = a == b
        }
    }
}
