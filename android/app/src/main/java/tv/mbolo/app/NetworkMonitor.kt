package tv.mbolo.app

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.NetworkRequest
import android.os.Handler
import android.os.Looper

/**
 * Surveillance « au moins un réseau avec Internet », compatible API 23+ :
 * on suit l'ensemble des réseaux disponibles via un NetworkCallback plutôt
 * que registerDefaultNetworkCallback (API 24) ou l'ancien broadcast
 * CONNECTIVITY_CHANGE (déprécié et imprécis).
 */
class NetworkMonitor(
    private val onAvailable: () -> Unit,
    private val onLost: () -> Unit,
) {
    private val available = mutableSetOf<Network>()
    private val mainHandler = Handler(Looper.getMainLooper())
    private var callback: ConnectivityManager.NetworkCallback? = null
    private var connectivityManager: ConnectivityManager? = null

    fun start(context: Context) {
        val cm = context.getSystemService(Context.CONNECTIVITY_SERVICE) as ConnectivityManager
        connectivityManager = cm
        // État initial immédiat, sans attendre le premier événement réseau.
        cm.allNetworks.forEach { network ->
            if (hasInternet(cm, network)) available.add(network)
        }
        val cb = object : ConnectivityManager.NetworkCallback() {
            override fun onAvailable(network: Network) {
                val first = available.isEmpty()
                available.add(network)
                if (first) mainHandler.post(onAvailable)
            }

            override fun onLost(network: Network) {
                available.remove(network)
                if (available.isEmpty()) mainHandler.post(onLost)
            }
        }
        callback = cb
        cm.registerNetworkCallback(
            NetworkRequest.Builder().addCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET).build(),
            cb,
        )
    }

    fun stop() {
        callback?.let { connectivityManager?.unregisterNetworkCallback(it) }
        callback = null
    }

    fun isOnline(): Boolean {
        val cm = connectivityManager ?: return false
        val network = cm.activeNetwork ?: return available.isNotEmpty()
        return hasInternet(cm, network) || available.isNotEmpty()
    }

    private fun hasInternet(cm: ConnectivityManager, network: Network): Boolean {
        val caps = cm.getNetworkCapabilities(network) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET)
    }
}
